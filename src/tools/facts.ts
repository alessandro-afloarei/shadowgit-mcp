import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { asClient } from '../client-name.js';
import type { EditedSymbol, FactsEdit, FactsRead } from '../fact-shapes.js';
import { runGit } from '../git.js';
import type { DependentRef } from '../map-shapes.js';
import { currentRepo, projectOfFile, readRepos } from '../repos.js';
import { AppNotRunningError, AppWithoutRouteError, readEditFacts, readFileFacts, sendFactsDelivered, type FactsDelivered } from '../session-api.js';
import { areaCount, counts } from './map.js';
import { quote, ruleLine } from './rules.js';
import { capList, capped, list, plural, report } from './shared.js';

// The hooks' budgets (the spec's sections 3 and 4): Claude Code caps a hook's context at 10,000 characters, and an
// exploring subagent reads dozens of files
const READ_CHARS = 600;
const EDIT_CHARS = 2_000;
/** The files of one edit the app takes. */
const MAX_EDIT_FILES = 20;
/** The rule matches one edit's block quotes. */
const RULE_MATCHES = 3;

const Filled = z.string().nullish();
const HookInput = z.object({
  event: Filled.describe("The hook's event"),
  tool: Filled.describe('The tool the hook followed: Read, Edit, Write or apply_patch'),
  file: Filled.describe('The file that tool read or changed'),
  agent: Filled.describe('The subagent it ran in; none in the main thread'),
  patch: Filled.describe("Codex's apply_patch text"),
});
type HookArgs = z.infer<typeof HookInput>;

/** A whole value the hook left as written: a placeholder it couldn't fill (`${agent_id}` in the main thread). */
const PLACEHOLDER = /^\$\{[^}]*\}$/;
/** A value the hook filled in: none for nothing or a placeholder; a patch's own `${…}` is code, and stays. */
const filled = (value?: string | null) => (value && !PLACEHOLDER.test(value) ? value : undefined);

type Baseline = { ok: true; snapshot: string | null } | { ok: false; error: string };

/** What one conversation's server remembers: what it said, by agent, file and fact, and each project's baseline. */
export interface FactsMemory {
  readonly said: Set<string>;
  readonly baselines: Map<string, Promise<Baseline>>;
}

/** The project's newest snapshot; null for a project with none yet. */
async function newestSnapshot(projectPath: string): Promise<Baseline> {
  const result = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!result.ok) return result;
  return { ok: true, snapshot: result.exitCode === 0 ? result.stdout.trim() : null };
}

/**
 * A project's baseline: its newest snapshot when the server first needed it, which never moves after. A failure is
 * read again at the next hook: one slow or failed git must not fail every edit of the conversation.
 */
function baselineOf(memory: FactsMemory, projectPath: string): Promise<Baseline> {
  const known = memory.baselines.get(projectPath);
  if (known !== undefined) return known;
  const reading = newestSnapshot(projectPath).then((baseline) => {
    if (!baseline.ok) memory.baselines.delete(projectPath);
    return baseline;
  });
  memory.baselines.set(projectPath, reading);
  return reading;
}

/**
 * A conversation's memory, the baseline of the project it started in read now, before the assistant's first edit. A
 * project list that can't be read is said here and again at the first hook, which reads it too.
 */
export function createFactsMemory(): FactsMemory {
  const memory: FactsMemory = { said: new Set(), baselines: new Map() };
  try {
    const start = currentRepo(readRepos());
    if (start !== null) void baselineOf(memory, start.path);
  } catch (error) {
    report(error);
  }
  return memory;
}

/** The paths a Codex patch touches, in order: each file it updates, adds, deletes or moves, a moved one by both names. */
export function patchPaths(patch: string): string[] {
  const paths = patch.split(/\r?\n/).flatMap((line) => /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/.exec(line)?.[1]?.trim() ?? []);
  return [...new Set(paths)];
}

/** A block a hook adds, its project and moment, and the counts the app records of it. */
type Block = Omit<FactsDelivered, 'aiTool' | 'chars' | 'ms'> & { readonly text: string };

/** The first rendering that fits `max` characters, else the last (the one that shows least), cut at `max` if it must. */
function fitting<T extends { text: string }>(attempts: readonly [T, ...T[]], max: number): T {
  const chosen = attempts.find((attempt) => attempt.text.length <= max) ?? attempts[attempts.length - 1] ?? attempts[0];
  return chosen.text.length <= max ? chosen : { ...chosen, text: `${chosen.text.slice(0, max - 1)}…` };
}

/** A read's block: where the file is, which of its symbols other areas use, and the rules that hold for it; none without either. */
function readText({ mapAsOf, files: [read], rules }: z.infer<typeof FactsRead>): Omit<Block, 'moment' | 'repoPath'> | null {
  if (read === undefined) return null;
  const used = read.onMap ? read.usedFrom : { items: [], total: 0 };
  const quoted = (rules ?? []).map(({ rule }) => ruleLine(rule));
  if (used.total === 0 && quoted.length === 0) return null;
  const where = read.onMap ? `is in the ${quote(read.area)} area${read.layer === null ? '' : `, layer ${read.layer}`}` : "isn't on it";
  const head = `ShadowGit's map (snapshot ${mapAsOf.snapshot.slice(0, 8)}, ${mapAsOf.time}): ${read.file} ${where}.`;
  const ruleLines = quoted.length === 0 ? [] : [`${quoted.length === 1 ? 'A rule holds' : `${quoted.length} rules hold`} for this file, quoted from .shadowgit-rules: ${quoted.join('; ')}.`];
  const attempt = (symbolCap: number, areaCap: number) => {
    const shown = capped(used, symbolCap);
    const usedLine = `Used from other areas: ${list(shown, (symbol) => `${symbol.name} (line ${symbol.line}) by ${capList(symbol.byArea, areaCap, areaCount, 'area')}`, '; ', 'symbol')}.`;
    return {
      text: [head, ...(used.total === 0 ? [] : [usedLine]), ...ruleLines].join('\n'),
      symbols: shown.items.length,
      dependents: shown.items.reduce((sum, symbol) => sum + symbol.byArea.reduce((areas, { count }) => areas + count, 0), 0),
      rules: quoted.length,
    };
  };
  return fitting([attempt(6, Infinity), attempt(3, 3), attempt(1, 1)], READ_CHARS);
}

type Edited = z.infer<typeof EditedSymbol>;
type Fact = 'removed' | 'signature' | 'unexported' | 'code';
const FACT_WORDS: Record<Fact, string> = { removed: 'removed', signature: 'its signature changed', unexported: 'no longer exported', code: 'its code changed' };
/** The facts that can break a caller: their dependents are listed, each with its line. */
const BREAKS = new Set<Fact>(['removed', 'signature', 'unexported']);

/** The one fact an edited symbol says, the first that holds; none for an added symbol or a change to comments or spacing alone. */
function factOf(symbol: Edited): Fact | null {
  if (symbol.delta === 'added') return null;
  if (symbol.delta === 'removed') return 'removed';
  if (symbol.change === 'comments' || symbol.change === 'spacing') return null;
  if (symbol.signature === true) return 'signature';
  if (symbol.wasExported === true && !symbol.exported) return 'unexported';
  return 'code';
}

/** A dependent where the edit can break it, with the line where it uses the symbol as its file is on disk. */
function dependentText(dependent: z.infer<typeof DependentRef>): string {
  if (!('symbol' in dependent)) return dependent.how.includes('calls') ? `top-level code in ${dependent.file}` : `${dependent.file} imports it`;
  const { name, file, line } = dependent.symbol;
  if (dependent.use === undefined) return `${name}, ${file}:${line}`;
  if ('changedSince' in dependent.use) return `${name}, ${file}:${line}, its file changed since the map's snapshot`;
  return `${name}, ${file}:${dependent.use.line}: ${quote(dependent.use.text)}`;
}

/** An edited symbol's fact, and its dependents: the first `cap` listed where the fact can break them, else counted by area. */
function symbolLines(symbol: Edited, fact: Fact, cap: number): { lines: string[]; dependents: number } {
  const at = symbol.line ?? symbol.baseLine;
  const said = `- ${symbol.name}${at === null ? '' : ` (line ${at})`}: ${FACT_WORDS[fact]}. ${symbol.dependentCount === 1 ? '1 depends on it' : `${symbol.dependentCount} depend on it`}`;
  const listed = BREAKS.has(fact) ? symbol.dependents : undefined;
  if (listed === undefined || listed.items.length === 0 || cap === 0) {
    return { lines: [`${said}, from ${counts(symbol.dependentsByArea)}${listed === undefined ? '' : ': get_code_context lists them'}.`], dependents: 0 };
  }
  const shown = listed.items.slice(0, cap);
  const more = listed.total - shown.length;
  return { lines: [`${said}:`, ...shown.map((dependent) => `  - ${dependentText(dependent)}`), ...(more > 0 ? [`  …and ${more} more: get_code_context lists them`] : [])], dependents: shown.length };
}

type Match = z.infer<typeof FactsEdit>['rules']['matches'][number];
const matchText = ({ rule, count, links }: Match) =>
  `It adds ${count === 1 ? 'a link' : `${count} links`} a rule names, quoted from .shadowgit-rules: ${ruleLine(rule)}: ${list({ items: links, total: count }, quote)}.`;

/** What a read file's facts say, once per agent and file. */
async function readBlock(memory: FactsMemory, agent: string, file: string, aiTool: string): Promise<Block | null> {
  const located = projectOfFile(file);
  if (located === null) return null;
  const key = ['read', agent, located.project.path, located.file].join('\0');
  if (memory.said.has(key)) return null;
  // A project's first hook takes its baseline, a read's too, without waiting for it: the edits that follow compare with it
  void baselineOf(memory, located.project.path);
  const facts = await readFileFacts({ repoPath: located.project.path, aiTool, files: [located.file] });
  if (facts === null) return null;
  memory.said.add(key);
  const block = readText(facts);
  return block === null ? null : { moment: 'read', repoPath: located.project.path, ...block };
}

/**
 * What an edit changed against the conversation's baseline, in the project of its first path: each changed symbol's
 * fact and its dependents, and the links it adds that a rule names, each said once per agent.
 */
async function editBlock(memory: FactsMemory, agent: string, paths: readonly string[], aiTool: string): Promise<Block | null> {
  const located = paths.map(projectOfFile).filter((each) => each !== null);
  const [first] = located;
  if (first === undefined) return null;
  const repoPath = first.project.path;
  const files = [...new Set(located.filter(({ project }) => project.path === repoPath).map(({ file }) => file))].slice(0, MAX_EDIT_FILES);
  const baseline = await baselineOf(memory, repoPath);
  if (!baseline.ok) throw new Error(baseline.error);
  if (baseline.snapshot === null) return null;
  const facts = await readEditFacts({ repoPath, aiTool, since: baseline.snapshot, files });
  if (facts === null) return null;

  const keyOf = (...parts: string[]) => [agent, repoPath, ...parts].join('\0');
  const symbols = facts.symbols.flatMap((symbol) => {
    const fact = factOf(symbol);
    if (fact === null || symbol.dependentCount === 0) return [];
    const key = keyOf('edit', symbol.path, symbol.name, symbol.kind, fact);
    return memory.said.has(key) ? [] : [{ symbol, fact, key }];
  });
  const matches = facts.rules.matches
    .map((match) => ({ match, key: keyOf('rule', match.rule.text, ...match.links) }))
    .filter(({ key }) => !memory.said.has(key))
    .slice(0, RULE_MATCHES);
  if (symbols.length === 0 && matches.length === 0) return null;

  const named = capList(files, 3, (file) => file, 'file');
  const head = `ShadowGit's map: ${named} compared with snapshot ${facts.since.snapshot.slice(0, 8)}, the newest when this conversation began.`;
  const attempt = (symbolCap: number, dependentCap: number) => {
    const shown = symbols.slice(0, symbolCap);
    const rendered = shown.map(({ symbol, fact }) => symbolLines(symbol, fact, dependentCap));
    const more = symbols.length - shown.length;
    const lines = [head, ...rendered.flatMap(({ lines: each }) => each), ...(more > 0 ? [`…and ${plural(more, 'more changed symbol')}: get_code_context lists their dependents.`] : []), ...matches.map(({ match }) => matchText(match))];
    return { text: lines.join('\n'), symbols: shown.length, dependents: rendered.reduce((sum, { dependents }) => sum + dependents, 0), rules: matches.length, keys: [...shown.map(({ key }) => key), ...matches.map(({ key }) => key)] };
  };
  const { keys, ...block } = fitting([attempt(6, 8), attempt(6, 4), attempt(6, 2), attempt(6, 0), attempt(3, 0), attempt(1, 0)], EDIT_CHARS);
  for (const key of keys) memory.said.add(key);
  return { moment: 'edit', repoPath, ...block };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'apply_patch']);

/** The block a hook's call asks for: a read's, an edit's (a file, or a Codex patch), or none after another tool. */
async function blockFor(memory: FactsMemory, input: HookArgs, aiTool: string): Promise<Block | null> {
  const agent = filled(input.agent) ?? '';
  const tool = filled(input.tool);
  const patch = filled(input.patch);
  const file = filled(input.file);
  if (patch !== undefined) return editBlock(memory, agent, patchPaths(patch), aiTool);
  if (file === undefined || tool === undefined) return null;
  if (tool === 'Read') return readBlock(memory, agent, file, aiTool);
  return EDIT_TOOLS.has(tool) ? editBlock(memory, agent, [file], aiTool) : null;
}

const EMPTY: CallToolResult = { content: [{ type: 'text', text: '' }] };

/**
 * A hook's answer: the facts of the file the assistant read or edited as the hook's JSON, or empty text when there is
 * nothing to say. Never an error for what is expected (the app closed or older, no project, no map yet); a real failure
 * throws, which the SDK answers as an error and the assistant shows as a hook error. Each block is recorded in the app
 * by its counts.
 */
export async function factsForHooks(memory: FactsMemory, input: HookArgs, aiTool: string): Promise<CallToolResult> {
  const started = performance.now();
  try {
    const block = await blockFor(memory, input, aiTool);
    if (block === null) return EMPTY;
    const { moment, repoPath, text, ...counted } = block;
    void sendFactsDelivered({ repoPath, aiTool, moment, ...counted, chars: text.length, ms: Math.round(performance.now() - started) }).catch(report);
    const answer = { hookSpecificOutput: { hookEventName: filled(input.event) ?? 'PostToolUse', additionalContext: text } };
    return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
  } catch (error) {
    // The app closed, or one before 0.7.0: the hook adds nothing, as it would without ShadowGit
    if (error instanceof AppNotRunningError || error instanceof AppWithoutRouteError) return EMPTY;
    throw error;
  }
}

export function registerFacts(server: McpServer): void {
  const memory = createFactsMemory();
  server.registerTool(
    'facts_for_hooks',
    {
      title: "Answer ShadowGit's hooks",
      description:
        "Answers ShadowGit's Read and Edit hooks, which call it after the assistant reads or changes a file in a ShadowGit-tracked project: what ShadowGit's map says of that file, as the hook's JSON, or nothing. For questions about code, call get_code_context instead.",
      inputSchema: HookInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    asClient(server, (input: HookArgs, aiTool) => factsForHooks(memory, input, aiTool)),
  );
}
