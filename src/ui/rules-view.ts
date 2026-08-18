// Renders the shared RULES blocks (src/ui/rules-text.ts) into the Rules panel. The same
// blocks are rendered as markdown into the README, so the page and the repo say one thing.

import { RULES, type RulesBlock } from './rules-text.js';
import { el } from './svg.js';

// `**bold**`, `` `code` `` and `[text](url)`. The URL pattern tolerates one level of nested
// parentheses, because the Wikipedia link is `.../Diplomacy_(game)`.
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g;

export function inlineNodes(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(el('strong', {}, [m[1]]));
    else if (m[2] !== undefined) out.push(el('code', {}, [m[2]]));
    else {
      out.push(el('a', { href: m[4]!, target: '_blank', rel: 'noreferrer noopener' }, [m[3]!]));
    }
    last = INLINE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function blockElement(block: RulesBlock): HTMLElement {
  switch (block.kind) {
    case 'heading':
      return el('h4', { class: 'rules-head' }, [block.text]);
    case 'para':
      return el('p', {}, inlineNodes(block.text));
    case 'bullets':
      return el(
        'ul',
        { class: 'rules-list' },
        block.items.map((t) => el('li', {}, inlineNodes(t))),
      );
    case 'table':
      return el('table', { class: 'rules-table' }, [
        el('thead', {}, [el('tr', {}, block.head.map((h) => el('th', {}, [h])))]),
        el(
          'tbody',
          {},
          block.rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, inlineNodes(c))))),
        ),
      ]);
  }
}

export function rulesElements(): HTMLElement[] {
  return [el('div', { class: 'rules' }, RULES.map(blockElement))];
}
