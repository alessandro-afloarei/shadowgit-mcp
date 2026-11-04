import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { asClient } from '../client-name.js';
import { DocPiece, DocsCursor, DocsRead, DocsWritten, type DocKey, type DocWords } from '../doc-shapes.js';
import { resolveRepo } from '../repos.js';
import { readDocs, sendDocs, type AppDocWrite } from '../session-api.js';
import { drawnFrom } from './map.js';
import { quote } from './rules.js';
import { andList, dataResult, forProject, list, plural, repoParam, Snapshot } from './shared.js';

// The app's cursor for all is more here: next is the step that follows, in every tool's answer, and the model reads
// the structured answer alone
const DocsOutput = z.object({
  repo: z.string(),
  ...DocsRead.omit({ next: true }).shape,
  more: DocsCursor.nullable().describe('For all: the following batch, to pass back as more; null at the last'),
  next: z.string().optional().describe('The step that follows: write these pages with write_docs'),
});
const WrittenOutput = z.object({ repo: z.string(), ...DocsWritten.shape });

type Read = z.infer<typeof DocsRead>;
type Page = Read['pages'][number];
type Facts = NonNullable<Page['facts']>;
type Words = z.infer<typeof DocWords>;

const BOTH = 'Ask for all, or name areas and the overview: not both.';
const HALF_RANGE = 'Pass base and head together.';
const ONE_ASK = 'Ask for a change with base and head, name areas, or ask for all: one of them.';

/** A page as the answers name it: the Overview, or an area by its id. */
export const pageName = (key: z.infer<typeof DocKey>) => ('area' in key ? key.area : 'the Overview');

/** A paragraph as text, each link after its text as the app names it: a symbol in its file, or an area by its id. */
const paragraph = (pieces: readonly z.infer<typeof DocPiece>[]) =>
  pieces.map(({ text, symbol, area }) => (symbol ? `[${text}](${symbol.name} in ${symbol.file})` : area !== undefined ? `[${text}](area ${area})` : text)).join('');

function wordsLines(words: Words): string[] {
  return [`    Summary: ${words.summary}`, ...words.body.map((pieces) => `    ${paragraph(pieces)}`)];
}

function stateLine({ state, words, changes, countFailure }: Page): string {
  const by = words === null ? '' : `written by ${words.author} at ${words.at.slice(0, 8)}`;
  switch (state) {
    case 'no-words':
      return 'no words yet';
    case 'current':
      return `current: words ${by}`;
    case 'behind':
      return `${plural(changes?.count ?? 0, 'change')} since its words, ${by}`;
    case 'not-in-map':
      // The app answers an id its map never held as a page without words: a page that left the map keeps its own
      return words === null ? 'not an area of the map' : `no longer in the map; words ${by}`;
    case 'not-counted':
      return `words ${by}; the changes since them could not be counted${countFailure === undefined ? '' : `: ${countFailure}`}`;
    default:
      // A state a newer app adds goes on as it is
      return by ? `${state}: words ${by}` : state;
  }
}

function factLines(facts: Facts): string[] {
  const links = (each: readonly { label: string; count: number }[]) => (each.length === 0 ? 'none' : each.map(({ label, count }) => `${quote(label)} (${count})`).join(', '));
  if ('folder' in facts) {
    return [
      `  Facts: folder ${facts.folder}; ${plural(facts.files, 'file')}, ${plural(facts.symbols, 'symbol')}; layers ${facts.layers.join(', ') || 'none'}.`,
      `  Depends on: ${links(facts.dependsOn)}. Depended on by: ${links(facts.dependedOnBy)}.`,
      ...(facts.processes.total > 0 ? [`  Processes: ${list(facts.processes, (process) => process)}.`] : []),
      ...(facts.mostDepended.total > 0
        ? [`  Most depended on: ${list(facts.mostDepended, ({ symbol, dependents }) => `${symbol.name} (${symbol.file}:${symbol.line}): ${plural(dependents, 'dependent')}`, '; ')}.`]
        : []),
    ];
  }
  const { files, symbols, areas, calls, processes } = facts.counts;
  return [
    `  Facts: ${plural(files, 'file')}, ${plural(symbols, 'symbol')}, ${plural(areas, 'area')}, ${plural(calls, 'call')}, ${plural(processes, 'process')}.`,
    `  Layers: ${facts.layers.map((layer) => `${layer.name} (${layer.kind}, ${plural(layer.files, 'file')})`).join(', ')}.`,
    `  Areas: ${list(facts.areas, (area) => `${quote(area.label)} (area ${area.id}): ${plural(area.files, 'file')}, ${plural(area.symbols, 'symbol')}`, '; ')}.`,
    ...(facts.links.total > 0 ? [`  Links between areas: ${list(facts.links, ({ from, to, count }) => `${quote(from.label)} → ${quote(to.label)} (${count})`)}.`] : []),
    ...(facts.processes.total > 0 ? [`  Processes: ${list(facts.processes, ({ label, areas: through }) => `${label} (${through.map(quote).join(' → ')})`, '; ')}.`] : []),
  ];
}

function changeLines(changes: NonNullable<Page['changes']>): string[] {
  const moved = (what: string, { added, removed }: { added: string[]; removed: string[] }) =>
    added.length + removed.length === 0 ? [] : [`  ${what} added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}.`];
  return [
    ...(changes.symbols.total > 0 ? ['  Symbols changed since the words:', list(changes.symbols, ({ name, path, change }) => `  - ${name} (${path}): ${change}`, '\n', 'symbol')] : []),
    ...changes.dependencies.map((sentence) => `  Dependency: ${sentence}`),
    ...(changes.goneLinks.length > 0 ? [`  Links of the words that name nothing now: ${changes.goneLinks.join('; ')}.`] : []),
    ...(changes.areas ? moved('Areas', changes.areas) : []),
    ...(changes.layers ? moved('Layers', changes.layers) : []),
  ];
}

function pageLines(page: Page): string[] {
  const name = 'area' in page.page ? `area ${page.page.area}` : 'the Overview';
  return [
    `Page ${quote(page.label)} (${name}): ${stateLine(page)}.`,
    ...(page.facts === null ? [] : factLines(page.facts)),
    ...(page.rules.length > 0 ? [`  The project's rules naming it: ${page.rules.map(quote).join(', ')}`] : []),
    ...(page.words === null ? [] : ['  Its words:', ...wordsLines(page.words.words)]),
    ...(page.changes === null ? [] : changeLines(page.changes)),
    ...(page.former ?? []).flatMap((former) => [`  Former page of area ${former.area}, whose files this area now holds:`, ...wordsLines(former.words)]),
  ];
}

/** Whether a page asks for words: a current one doesn't, and the map no longer holds an area whose page left it. */
const needsWords = ({ state }: Page) => state !== 'current' && state !== 'not-in-map';

/** The pages to write, named, at head, then the next batch of all; none when every page read is current. */
function writeStep({ head, limits, pages, next: more }: Read): string | undefined {
  const asked = pages.filter(needsWords);
  if (asked.length === 0) return undefined;
  const words = `for each page a summary of one sentence (at most ${limits.summary} characters) and a body of short paragraphs (at most ${limits.bodyWords} words) on what the code you read does, linking the symbols and areas it names; a page with no words can start short, from its facts and the code you read, and later sessions add to it; or holds: true where its words still hold`;
  const following = more === null ? '' : ` Then get_docs with more ${JSON.stringify(more)} for the next pages without words.`;
  // A first page needs no whole folder read: it says what the facts and the code read show, and grows with the work
  return `Write the words of ${andList(asked.map(({ page }) => pageName(page)))} with write_docs, head ${JSON.stringify(head)}: ${words}.${following}`;
}

/** `none` says what an answer without pages means for what was asked; the app answers every page named. */
function describeDocs(repo: string, read: Read, none: string, step: string | undefined): string {
  if (read.pages.length === 0) return none;
  return [
    `${repo}'s docs pages, at snapshot ${read.head.slice(0, 8)}; the map is ${drawnFrom(read.mapAsOf)}`,
    ...read.pages.flatMap((page) => ['', ...pageLines(page)]),
    ...(step === undefined ? [] : ['', `Next: ${step}`]),
  ].join('\n');
}

export async function getDocs({
  base,
  head,
  areas = [],
  overview = false,
  all = false,
  more,
  repo,
}: {
  base?: string | null;
  head?: string;
  areas?: string[];
  overview?: boolean;
  all?: boolean;
  more?: z.infer<typeof DocsCursor>;
  repo?: string;
}): Promise<CallToolResult> {
  // more goes on from all's answer: it is a batch of all
  const batch = all || more !== undefined;
  const named = areas.length > 0 || overview;
  if (batch && named) throw new Error(BOTH);
  // A base of null is a range from the start of the history: only a base left out is half a range
  if ((base === undefined) !== (head === undefined)) throw new Error(HALF_RANGE);
  const ranged = head !== undefined;
  if (ranged && (batch || named)) throw new Error(ONE_ASK);
  const project = resolveRepo(repo);
  const read = await readDocs({ repoPath: project.path, base, head, areas, overview, all: batch, next: more });
  // Another project's steps name it: get_docs with more, or write_docs, without repo would read the current one
  const written = writeStep(read);
  const step = written === undefined ? undefined : `${forProject(repo, project)}${written}`;
  const { next: cursor, ...rest } = read;
  const none = ranged
    ? `That change touched no area of ${project.name} whose docs page needs words.`
    : batch
      ? `Every page of ${project.name}'s map has words.`
      : `Your latest session in ${project.name} changed no area whose docs page needs words.`;
  return dataResult(DocsOutput, describeDocs(project.name, read, none, step), { repo: project.name, ...rest, more: cursor, ...(step !== undefined && { next: step }) });
}

// code-graph's DOC_LIMITS, which get_docs answers as limits
const SUMMARY_MAX = 200;
const BODY_WORDS_MAX = 400;

/** A page as write_docs takes it: flat, for a model to fill. */
const PageInput = z.object({
  area: z.string().min(1).optional().describe("The area's id, as get_docs names it"),
  overview: z.boolean().optional().describe('The Overview page, in place of an area'),
  holds: z.boolean().optional().describe('The words the page has still hold: kept again at head, unchanged'),
  summary: z.string().optional().describe('One sentence on what the area is for'),
  body: z
    .array(z.union([z.string(), z.array(DocPiece)]))
    .optional()
    .describe('Short paragraphs on how it works: each plain text, or pieces, a piece linking a symbol (file and name) or an area (id) where its text names it'),
});

/** A page as the app takes it; throws for a page no app could read. The app checks each page's words on its own. */
function appPage({ area, overview, holds, summary, body }: z.infer<typeof PageInput>, place: number): AppDocWrite {
  const page = `Page ${place + 1}`;
  if (area !== undefined && overview) throw new Error(`${page} names an area and the overview: name one.`);
  const key = overview ? { overview: true as const } : area !== undefined ? { area } : null;
  if (key === null) throw new Error(`${page} names no area and not the overview: name one.`);
  if (holds) {
    if (summary !== undefined || body !== undefined) throw new Error(`${page} sends words and holds: send one.`);
    return { ...key, holds: true };
  }
  if (summary === undefined || body === undefined) {
    throw new Error(`${page} sends neither words (a summary and a body) nor holds: send words, or holds: true where its words still hold.`);
  }
  // A plain paragraph is one piece of text
  return { ...key, words: { summary, body: body.map((pieces) => (typeof pieces === 'string' ? [{ text: pieces }] : pieces)) } };
}

export async function writeDocs({ head, pages, repo }: { head: string; pages: z.infer<typeof PageInput>[]; repo?: string }, author: string): Promise<CallToolResult> {
  const sent = pages.map(appPage);
  const project = resolveRepo(repo);
  const written = await sendDocs({ repoPath: project.path, head, author, pages: sent });
  const at = written.head.slice(0, 8);
  const kept = written.pages.filter((page) => page.kept);
  // Left out: pages the app refused once it read the map, and, from 0.4.0, those whose words were past its rules
  const left = [
    ...written.pages.flatMap((page) => (page.kept ? [] : [`${pageName(page.page)}: ${page.reason}`])),
    ...(written.left ?? []).map(({ page, why }) => `${page === null ? 'a page' : pageName(page)}: ${why}`),
  ];
  const text = [
    kept.length > 0 ? `ShadowGit keeps your words for ${andList(kept.map(({ page }) => pageName(page)))}, at snapshot ${at}.` : 'ShadowGit kept no words.',
    ...kept.flatMap(({ page, dropped }) => (dropped.length > 0 ? [`Made plain text in ${pageName(page)}, naming nothing at ${at}: ${dropped.join('; ')}.`] : [])),
    ...(left.length > 0 ? [`Left out: ${left.join('; ')}.`] : []),
  ].join(' ');
  return dataResult(WrittenOutput, text, { repo: project.name, ...written });
}

export function registerDocs(server: McpServer): void {
  server.registerTool(
    'get_docs',
    {
      title: 'Read docs pages',
      description:
        "Read the docs pages ShadowGit keeps for a tracked project: one per area of its map, plus an Overview, each written by an assistant. A page comes with the facts ShadowGit draws from the map (folder, sizes, layers, what it depends on and what depends on it, processes, its most depended-on symbols, the project's rules that name it), its words so far with who wrote them and at which snapshot, and what changed in the area since them: symbols changed in their code, dependency facts, links that no longer name anything. With no arguments: the pages your latest session changed whose words are missing or behind. With base and head: the pages changed between those snapshots whose words are missing or behind. With areas, and overview: those pages. With all: pages without words, largest area first, five at a time, with more for the following batch. Answers head, the snapshot write_docs keeps the words at, and next: write the pages' words with write_docs. Needs the ShadowGit app running.",
      inputSchema: z.object({
        base: Snapshot.nullable().optional().describe('With head: the pages changed between these snapshots, as get_lens names them; null from the start of the history'),
        head: Snapshot.optional().describe('With base: the newer snapshot'),
        areas: z.array(z.string().min(1)).max(20).optional().describe("Area ids, as get_docs names them: most are the area's folder, as get_map lists it"),
        overview: z.boolean().optional().describe('The Overview page, alone or with areas'),
        all: z.boolean().optional().describe('Pages without words, five at a time'),
        more: DocsCursor.optional().describe('The more get_docs answered with all, as given: the following batch'),
        repo: repoParam,
      }),
      outputSchema: DocsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    asClient(server, getDocs),
  );
  server.registerTool(
    'write_docs',
    {
      title: 'Write docs pages',
      description:
        `Write the words of docs pages get_docs read, at the head it answered. For each page, an area by its id or overview: true, then a summary, one sentence on what it is for (at most ${SUMMARY_MAX} characters), and a body, short paragraphs on how it works (at most ${BODY_WORDS_MAX} words), each paragraph text or pieces, a piece linking a symbol (its file and name, as get_docs and get_code_context name them) or an area by its id, where the text names it. Or holds: true, when the words still hold after the changes get_docs listed: they are kept again at head, unchanged. Describe what the code does and how it works, from the code you read and the facts get_docs gave: a page with no words can start short, and later sessions add to it. Links that name nothing at head are made plain text and named back. A page past these limits is left out, with why; the others are kept. ShadowGit keeps every version in its own history, never in the project's files.`,
      inputSchema: z.object({
        head: Snapshot.describe('The head get_docs answered'),
        pages: z.array(PageInput).min(1).max(10),
        repo: repoParam,
      }),
      outputSchema: WrittenOutput,
      // Destructive: words written for a page replace the ones it had
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    asClient(server, writeDocs),
  );
}
