import { describe, expect, it } from 'vitest';
import { SummaryRead } from '../src/map-shapes.js';
import { outlineText } from '../src/outline.js';
import { MAP_ANSWERS, RULES_ANSWERS } from './helpers/fake-app.js';

const map = SummaryRead.parse(MAP_ANSWERS.outline);
const rules = SummaryRead.parse(RULES_ANSWERS.outline);
const FIRST = "This project, webshop, on ShadowGit's map (snapshot c22ec972, 2026-11-12T10:53:22+01:00): 19 files, 3 areas, 3 layers.";
const LAST = 'get_map and get_docs read more.';

describe("the project's outline in the instructions", () => {
  it('names the project, its snapshot and counts, its areas, its links and its processes, the rest counted', () => {
    expect(outlineText('webshop', map, 4_000).split('\n')).toEqual([
      FIRST,
      'Areas: "api" (8 files), "billing" (6 files), "jobs" (5 files).',
      'Most links: "api" → "billing" (3 calls and imports), "jobs" → "billing" (3 calls and imports).',
      'Processes: StartServer -> RoundCents: "api" → "billing"; StartServer -> RecordPayment: "api" → "billing"; StartServer -> Shipping: "api"; InvoiceLine -> RoundCents: "billing"; CleanupCarts -> MaxDelay: "jobs"; StartServer -> ValidateCart: "api" …and 7 more processes.',
      LAST,
    ]);
  });

  it("quotes the project's rules as written, with their reasons", () => {
    expect(outlineText('webshop', rules, 4_000)).toContain('Rules, quoted from .shadowgit-rules: "src/jobs never depends on src/api" because "jobs read the database through src/db".');
    expect(outlineText('webshop', map, 4_000)).not.toContain('Rules');
  });

  it('halves its lists until it fits its budget, keeping its first and last lines', () => {
    const full = outlineText('webshop', map, 4_000);
    const halved = outlineText('webshop', map, full.length - 1);
    expect(halved.length).toBeLessThan(full.length);
    expect(halved).toContain('…and 10 more processes.');
    expect(outlineText('webshop', map, 100).split('\n')).toEqual([FIRST, LAST]);
  });
});
