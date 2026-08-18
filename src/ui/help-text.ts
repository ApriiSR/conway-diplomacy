/**
 * The "how to run a game" copy, in one place. It is shown twice — as the first-run card
 * in the panel, and on demand from the `?` button / the ⋯ menu — so edit it here and both
 * appearances follow.
 */

export const HELP_TITLE = 'Running a game here';

export interface HelpStep {
  text: string;
  /** Optional nested bullets, rendered under the step in both the card and the modal. */
  sub?: string[];
}

export const HELP_STEPS: HelpStep[] = [
  { text: 'Name the game (top left) — it gets drawn onto exported images.' },
  {
    text: 'Enter the turn’s orders. Three ways, and they mix freely:',
    sub: [
      'Paste everyone’s orders into the All tab, with `France:` style headers.',
      'Or put each player’s orders in that player’s own power tab.',
      'Or click a unit on the board, then its destination.',
    ],
  },
  {
    text:
      'Read the readiness strip. Each power’s chip shows how many of that player’s units have ' +
      'been given orders out of how many they have — “E 3/5” (England: three of five units ordered) ' +
      'means the other two will hold. A red badge counts lines that didn’t parse; click a chip for ' +
      'the detail.',
  },
  { text: 'Fix anything flagged red, then Adjudicate — if problems remain it lists them and asks first.' },
  { text: 'Send the results text and the board image to your players.' },
];

export const HELP_ALSO_TITLE = 'Also';

export const HELP_ALSO: string[] = [
  'Spawn choices — when the Life step births a unit on a coast, its owner picks army or fleet. Use the buttons, or type the decisions like builds (`England: Build F Edi`). If no choice is given, the new unit is an army, so a quiet player never holds the turn up.',
  'Share link — hands anyone an independent copy of the board to experiment with. Nothing they do there affects your game.',
  'Export / Import JSON — saves or restores a whole game, history included. Use it to back a game up, or to move it to another browser.',
];
