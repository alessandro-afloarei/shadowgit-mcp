import * as z from 'zod/v4';
import { AreaCount, DependentRef, MapAsOf, listed } from './map-shapes.js';
import { RuleCheck, RulesFailure, RulesFor } from './rule-shapes.js';

// The facts the app answers the assistant's hooks with, from ShadowGit 0.7.0's POST /api/map/facts: mirrored as the
// map shapes are (electron/code-graph/map-facts.ts and code-graph's lens/edit-facts). Open values (a symbol's delta and
// kind of change) are strings, which a newer app may add to.

/** One of a read file's symbols that other areas use: where it is, and how many of each area use it. */
const UsedFrom = z.object({ name: z.string(), line: z.number().int(), byArea: z.array(AreaCount) });

/** What the map says of a file the assistant read: off it, or its area and layer and which of its symbols other areas use. */
const ReadFacts = z.union([
  z.object({ file: z.string(), onMap: z.literal(false) }),
  z.object({ file: z.string(), onMap: z.literal(true), area: z.string(), layer: z.string().nullable(), usedFrom: listed(UsedFrom) }),
]);

/** A read's facts: each file's, and the project's rules that hold for them (null without a .shadowgit-rules). */
export const FactsRead = z.object({ mapAsOf: MapAsOf, files: z.array(ReadFacts), rules: RulesFor.nullable(), rulesFailure: RulesFailure });

/** A symbol an edit changed against the baseline, with what depends on it on the map. */
export const EditedSymbol = z.object({
  key: z.string(),
  name: z.string(),
  kind: z.string(),
  path: z.string(),
  line: z.number().int().nullable().describe('Its first line now; null once removed'),
  baseLine: z.number().int().nullable().describe('Its first line at the baseline; null when added'),
  delta: z.string().describe('added, modified or removed'),
  change: z.string().describe('code, runtime, export, comments or spacing'),
  signature: z.boolean().nullable().describe('Modified only: whether its declaration without its body changed'),
  exported: z.boolean(),
  wasExported: z.boolean().nullable(),
  dependentCount: z.number().int(),
  dependentsByArea: z.array(AreaCount),
  dependents: listed(DependentRef).optional().describe('Listed where the edit can break them: removed, signature changed, no longer exported'),
});

/** An edit's facts: its changed symbols against the baseline, and the links it adds that a rule names. */
export const FactsEdit = z.object({
  since: z.object({ snapshot: z.string(), time: z.string() }),
  mapAsOf: MapAsOf,
  symbols: z.array(EditedSymbol),
  rules: RuleCheck,
  rulesFailure: RulesFailure,
  skipped: z.array(z.string()).describe('Files past the engine size limit, left out'),
});
