// The rules exist once, in src/ui/rules-text.ts. The README's rules section is generated
// from them, and this test is what stops the two drifting: it fails if the committed README
// no longer matches, and rewrites it when run as `UPDATE_README=1 npx vitest run`
// (which is what `npm run rules:sync` does).

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RULES, rulesMarkdown } from '../../src/ui/rules-text';

const README = fileURLToPath(new URL('../../README.md', import.meta.url));
const BEGIN = '<!-- RULES:BEGIN';
const END = '<!-- RULES:END -->';

function splice(text: string, body: string): string {
  const openStart = text.indexOf(BEGIN);
  const openEnd = text.indexOf('-->', openStart) + '-->'.length;
  const close = text.indexOf(END);
  return `${text.slice(0, openEnd)}\n\n${body}\n\n${text.slice(close)}`;
}

describe('README rules section', () => {
  it('matches src/ui/rules-text.ts', () => {
    const text = readFileSync(README, 'utf8');
    expect(text).toContain(BEGIN);
    expect(text).toContain(END);
    const wanted = splice(text, rulesMarkdown());
    if (process.env.UPDATE_README && wanted !== text) {
      writeFileSync(README, wanted);
      return;
    }
    expect(
      text,
      'README rules section is stale — run `npm run rules:sync`',
    ).toBe(wanted);
  });
});

describe('rulesMarkdown', () => {
  it('renders every block kind', () => {
    const md = rulesMarkdown();
    expect(md).toContain('## Edge cases');
    expect(md).toContain('| Province | Occupied neighbours | Result |');
    expect(md).toContain('- They never move and are never ordered.');
    // The one ruling the video doesn't cover has to stay marked as this tool's own.
    expect(md).toContain("**Split-coast spawns are this tool's own ruling.**");
    // No leftover (V)/(H) provenance markers.
    expect(md).not.toMatch(/\((V|H)\b/);
  });

  it('has no empty blocks', () => {
    for (const b of RULES) {
      if (b.kind === 'bullets') expect(b.items.length).toBeGreaterThan(0);
      if (b.kind === 'table') expect(b.rows.length).toBeGreaterThan(0);
      if (b.kind === 'para' || b.kind === 'heading') expect(b.text.trim()).not.toBe('');
    }
  });
});
