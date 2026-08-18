// Shared model for the Conway's Game of Diplomacy adjudicator. Every other module
// depends on these types, so extend them here first rather than widening locally.

export type Power =
  | 'AUSTRIA' | 'ENGLAND' | 'FRANCE' | 'GERMANY' | 'ITALY' | 'RUSSIA' | 'TURKEY'
  | 'NEUTRAL';

export const GREAT_POWERS: readonly Power[] =
  ['AUSTRIA', 'ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'];

export type UnitType = 'A' | 'F';

/** Location id: lowercase province, optional coast: 'par', 'spa/sc', 'stp/nc'. */
export type Loc = string;
/** Province id without coast: 'spa'. */
export type ProvinceId = string;

export interface Unit {
  power: Power;
  type: UnitType;
  loc: Loc;
}

export type ProvinceType = 'inland' | 'coastal' | 'sea';

export interface Province {
  id: ProvinceId;
  name: string;
  type: ProvinceType;
  sc: boolean;
  home: Power | null;
  /** Coast ids if split-coast province, e.g. ['nc','sc'] for spa. */
  coasts: string[];
  /** Locs an army may move to from this province. */
  armyAdj: Loc[];
  /** Locs a fleet may move to, keyed by coast ('' for a single-coast province / sea). */
  fleetAdj: Record<string, Loc[]>;
}

export interface MapData {
  provinces: Record<ProvinceId, Province>;
  /** Raw undirected province graph used by the Life step (coasts collapsed, seas included). */
  lifeAdjacency: Record<ProvinceId, ProvinceId[]>;
  startingUnits: Unit[];
  startingCenters: Partial<Record<Power, ProvinceId[]>>;
}

// ---------- Orders ----------

export type MoveOrder    = { kind: 'move';    unit: Unit; to: Loc; viaConvoy?: boolean };
export type HoldOrder    = { kind: 'hold';    unit: Unit };
export type SupportOrder = { kind: 'support'; unit: Unit; target: Unit; to?: Loc }; // to undefined = support hold
export type ConvoyOrder  = { kind: 'convoy';  unit: Unit; target: Unit; to: Loc };
export type MovementOrder = MoveOrder | HoldOrder | SupportOrder | ConvoyOrder;

export type RetreatOrder = { kind: 'retreat'; unit: Unit; to: Loc } | { kind: 'disband'; unit: Unit };
export type BuildOrder   = { kind: 'build'; unit: Unit } | { kind: 'remove'; unit: Unit } | { kind: 'waive'; power: Power };

export type Order = MovementOrder | RetreatOrder | BuildOrder;

export type OrderResult =
  | 'ok' | 'bounce' | 'cut' | 'void' | 'no-convoy' | 'dislodged' | 'disrupted' | 'disband';

export interface ResultEntry {
  order: Order;
  result: OrderResult;
  /** Shown in parentheses after the result, e.g. 'defaulted, no order given'. */
  note?: string;
}

// ---------- Phases ----------

/**
 * SUMMER is the interval between Spring and Fall that the post-Spring Life step happens
 * in. It has no movement phase, but it is an order season all the same: the coastal births
 * that step produces are decided by build orders, in its SPAWN_CHOICE phase. (Winter's
 * Life step stays in WINTER — it runs after that season's adjustments.)
 */
export type Season = 'SPRING' | 'SUMMER' | 'FALL' | 'WINTER';
export type PhaseKind =
  | 'MOVEMENT'      // spring/fall orders
  | 'RETREAT'       // spring/fall retreats (skipped when nothing is dislodged)
  | 'ADJUSTMENT'    // winter builds/removes
  | 'SPAWN_CHOICE'; // Life step ran; GM must record A/F(+coast) for coastal births before continuing

export interface Dislodgement {
  unit: Unit;
  /** Province the attack came from (retreat there is illegal). */
  attackerFrom: ProvinceId;
  /** Legal retreat locs (empty => must disband). */
  retreatOptions: Loc[];
}

export interface LifeEvent {
  kind: 'death' | 'birth';
  province: ProvinceId;
  /** For deaths: the unit removed. For births: the resolved unit, or null while type is undecided. */
  unit: Unit | null;
  power: Power;             // owner (births: majority parent power or NEUTRAL)
  neighbours: number;       // occupied-neighbour count that triggered this
  parents?: Unit[];         // births only
  /** Births only: true if the GM still has to pick army/fleet (+coast). */
  pending?: boolean;
}

export interface LifeResult {
  units: Unit[];            // board after the step, EXCLUDING pending births
  events: LifeEvent[];
  pending: LifeEvent[];     // subset of events with pending === true
}

// ---------- Game state ----------

export type Variant = 'conway' | 'standard';

export interface GameState {
  version: 1;
  /** 'conway' (default) runs the Life step; 'standard' is plain Diplomacy. Absent = 'conway'. */
  variant?: Variant;
  year: number;
  season: Season;
  phase: PhaseKind;
  units: Unit[];
  centers: Partial<Record<Power, ProvinceId[]>>;
  /** Present during RETREAT phase. */
  dislodged?: Dislodgement[];
  /** Present during SPAWN_CHOICE phase. */
  pendingBirths?: LifeEvent[];
  /** Cosmetic per-power display names (e.g. player handles) — GM-editable. */
  labels?: Partial<Record<Power, string>>;
}

/** One resolved phase, kept for history/undo and for rendering result arrows. */
export interface PhaseRecord {
  before: GameState;
  orders: Order[];
  results: ResultEntry[];
  life?: LifeResult;
  after: GameState;
}
