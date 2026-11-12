import type * as z from 'zod/v4';
import type { SummaryRead } from './map-shapes.js';
import { currentRepo, readRepos } from './repos.js';
import { readOutline } from './session-api.js';
import { quote, ruleLine } from './tools/rules.js';
import { list, plural, type Listed } from './tools/shared.js';

type Outline = z.infer<typeof SummaryRead>;

/** The first `cap` of a list the app capped, and how many there are in all. */
const capped = <T>({ items, total }: Listed<T>, cap: number): Listed<T> => ({ items: items.slice(0, cap), total });

/** The outline's head and tail, and between them its lists, each cut at its cap times `scale`. */
function outlineLines(repo: string, { mapAsOf, summary, rules }: Outline, scale: number) {
  const cap = (count: number) => Math.max(1, Math.floor(count * scale));
  const { files, areas } = summary.counts;
  const lists = [
    summary.areas.total > 0 && `Areas: ${list(capped(summary.areas, cap(12)), (area) => `${quote(area.label)} (${plural(area.files, 'file')})`, ', ', 'area')}.`,
    summary.links.total > 0 && `Most links: ${list(capped(summary.links, cap(8)), (link) => `${quote(link.from)} → ${quote(link.to)} (${link.count} calls and imports)`, ', ', 'link')}.`,
    summary.processes.total > 0 && `Processes: ${list(capped(summary.processes, cap(6)), (process) => `${quote(process.label)}: ${process.areas.map(quote).join(' → ')}`, '; ', 'process')}.`,
    rules && rules.rules.length > 0 && `Rules, quoted from .shadowgit-rules: ${list(capped({ items: rules.rules, total: rules.rules.length }, cap(8)), ruleLine, '; ', 'rule')}.`,
  ].filter((line) => typeof line === 'string');
  return {
    head: `This project, ${quote(repo)}, on ShadowGit's map (snapshot ${mapAsOf.snapshot.slice(0, 8)}, ${mapAsOf.time}): ${plural(files, 'file')}, ${plural(areas, 'area')}, ${plural(summary.layers.length, 'layer')}.`,
    lists,
    tail: 'get_map and get_docs read more.',
  };
}

/**
 * The project's outline as the instructions end with it: where it is on the map, its areas, the links between them,
 * its processes and its rules. Every name from the project is quoted, as text, not as instructions: the instructions
 * are what the model trusts most. Over `budget` characters, every list's cap is halved until it fits; the head and
 * the tail always stay.
 */
export function outlineText(repo: string, read: Outline, budget: number): string {
  for (const scale of [1, 1 / 2, 1 / 4, 1 / 8]) {
    const { head, lists, tail } = outlineLines(repo, read, scale);
    const text = [head, ...lists, tail].join('\n');
    if (text.length <= budget) return text;
  }
  const { head, tail } = outlineLines(repo, read, 1);
  return [head, tail].join('\n');
}

/** The outline of the project the server starts in, within `budget`: null without one, or with no answer in time. */
export async function outlineAtStart(budget: number): Promise<string | null> {
  const project = currentRepo(readRepos());
  if (project === null) return null;
  const read = await readOutline(project.path);
  return read === null ? null : outlineText(project.name, read, budget);
}
