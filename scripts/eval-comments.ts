/**
 * Whether Claude Code addresses the person's ShadowGit review comments as they ask: told "Address my ShadowGit review
 * comments." in the map webshop, with the four comments the real app answered for it (comments/open.json). Two ask
 * for a change at their lines (#1: free shipping from 100 in shipping; #3: number the orders from 1 in listOrders),
 * one is a question (#2, on applyDiscount) and one a note (#4, on purgeLogs). A run passes when it read the comments
 * with get_review_comments before its first edit, replied to all four, changed src/api/cart.ts and src/api/orders.ts
 * only inside the commented definitions and as asked, and changed no other file. The eval passes at 8 runs of 10.
 * Spends tokens and its results vary, so it runs by hand before a release, beside the other evals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { COMMENT_ANSWERS, MAP_PROJECT, startFakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs } from '../tests/helpers/fixtures.js';
import { EDITS, STREAM_ARGS, ago, readStream, runClaude } from './claude.js';

const RUNS = Number(process.env.RUNS ?? 10);
const PASS_AT = Math.ceil(0.8 * RUNS);
const PROMPT = 'Address my ShadowGit review comments.';
const COMMENTS = [1, 2, 3, 4];

/** The definitions the change comments are on, by their lines in MAP_PROJECT, and whether a change does what the comment asks. */
const ASKED: Record<string, { start: number; end: number; done: (span: string) => boolean }> = {
  'src/api/cart.ts': { start: 10, end: 12, done: (span) => /\b100\b/.test(span) },
  'src/api/orders.ts': { start: 15, end: 17, done: (span) => !span.includes('createOrder(i))') },
};

/** The project's files, by their path in it, without the histories and Claude Code's own folder. */
function filesOf(project: string): Map<string, string> {
  const skip = /^(\.git|\.shadowgit\.git|\.claude)(\/|$)/;
  const files = fs.readdirSync(project, { recursive: true, encoding: 'utf8' }).map((file) => file.split(path.sep).join('/')).filter((file) => !skip.test(file));
  return new Map(files.filter((file) => fs.statSync(path.join(project, file)).isFile()).map((file) => [file, fs.readFileSync(path.join(project, file), 'utf8')]));
}

/** The lines of `file` that stand where lines start to end stood, when every line outside them is as it was; null otherwise. */
function spanOf(file: string, text: string, { start, end }: { start: number; end: number }): string | null {
  const before = (MAP_PROJECT[file] ?? '').split('\n');
  const after = text.split('\n');
  const tail = before.length - end;
  const head = before.slice(0, start - 1);
  if (after.length - tail < head.length) return null;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, at) => line === b[at]);
  if (!same(after.slice(0, start - 1), head) || !same(after.slice(after.length - tail), before.slice(end))) return null;
  return after.slice(start - 1, after.length - tail).join('\n');
}

/** spanOf finds the definition in the untouched file, none after an edit above it, and one after an edit inside it. */
function selfCheck(): void {
  const cart = MAP_PROJECT['src/api/cart.ts'] ?? '';
  const lines = cart.split('\n');
  const inside = [...lines.slice(0, 10), '  return total >= 100 ? 0 : 5;', ...lines.slice(11)].join('\n');
  const checks = [
    spanOf('src/api/cart.ts', cart, ASKED['src/api/cart.ts'] ?? { start: 0, end: 0 }) !== null,
    spanOf('src/api/cart.ts', `// moved\n${cart}`, { start: 10, end: 12 }) === null,
    ASKED['src/api/cart.ts']?.done(spanOf('src/api/cart.ts', inside, { start: 10, end: 12 }) ?? '') === true,
  ];
  if (!checks.every(Boolean)) throw new Error(`self-check: ${JSON.stringify(checks)}`);
  console.log('self-check: the definition read untouched, refused after an edit above it, and the change found inside it');
}

type Run = { passed: boolean };

async function run(label: string): Promise<Run | null> {
  const app = await startFakeApp();
  try {
    const project = makeProject('webshop', MAP_PROJECT, ago(60));
    app.commentsAnswer = COMMENT_ANSWERS.open;
    const { calls, reply, cost } = readStream(await runClaude({ prompt: PROMPT, project, app, timeoutMs: 420_000, args: STREAM_ARGS }));

    const read = calls.findIndex((call) => call.name === 'mcp__shadowgit__get_review_comments');
    const edited = calls.findIndex((call) => EDITS.has(call.name));
    const replies = app.requestsTo('/comments/reply');
    const replied = new Set(replies.map((body) => Number(body.id)));
    const files = filesOf(project);
    const changed = [...new Set([...files.keys(), ...Object.keys(MAP_PROJECT)])].filter((file) => files.get(file) !== MAP_PROJECT[file]);

    const failures = [
      ...(read === -1 ? ['never read the comments'] : edited !== -1 && edited < read ? ['edited before reading the comments'] : []),
      ...COMMENTS.filter((id) => !replied.has(id)).map((id) => `no reply to #${id}`),
      ...changed.filter((file) => ASKED[file] === undefined).map((file) => `changed ${file}`),
      ...Object.entries(ASKED).flatMap(([file, asked]) => {
        const span = spanOf(file, files.get(file) ?? '', asked);
        if (span === null) return [`changed ${file} outside lines ${asked.start}-${asked.end}`];
        return asked.done(span) ? [] : [`${file}: not the change asked`];
      }),
    ];
    const passed = failures.length === 0;
    console.log(`${label}: ${passed ? 'PASS' : `FAIL (${failures.join('; ')})`} cost=$${cost.toFixed(2)}`);
    console.log(`  tools: ${calls.map((call) => call.name.replace('mcp__shadowgit__', 'shadowgit:')).join(' → ') || 'none'}`);
    for (const body of replies) console.log(`  reply #${String(body.id)}: ${String(body.text).replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log(`  says: ${reply.replace(/\s+/g, ' ').slice(0, 300)}`);
    return { passed };
  } catch (error) {
    console.log(`${label}: error ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    return null;
  } finally {
    await app.close();
    removeTempDirs();
  }
}

selfCheck();
const runs: (Run | null)[] = [];
for (let i = 1; i <= RUNS; i++) runs.push(await run(`run ${i}`));
const passed = runs.filter((result) => result?.passed).length;
const errors = runs.filter((result) => result === null).length;
console.log(`\n${passed} of ${RUNS} runs addressed the comments as asked (pass at ${PASS_AT})`);
if (errors > 0) console.log(`${errors} runs errored, counted as neither`);
process.exitCode = passed >= PASS_AT ? 0 : 1;
