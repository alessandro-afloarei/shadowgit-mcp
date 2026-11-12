/**
 * Whether ShadowGit's hooks give Claude Code the map's facts as it works: eval:map's task (a change to a function two
 * other areas depend on, in the map webshop), with the hooks Connect writes for Claude Code, passed with --settings,
 * and no word about ShadowGit. The fake app answers with the real app's answers: the outline, the read facts of
 * charge.ts (other files' say nothing), the edit facts of a change to chargeCard, its context with each dependent's
 * line. A run passes when a read block reached Claude Code before its first edit and an edit block after it; the eval
 * passes at 4 runs of 5. Spends tokens and its results vary, so it runs by hand before a release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAP_ANSWERS, MAP_PROJECT, startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs } from '../tests/helpers/fixtures.js';
import { STREAM_ARGS, ago, readStream, runClaude } from './claude.js';

const RUNS = Number(process.env.RUNS ?? 5);
const PASS_AT = 4;
const TASK = 'Make chargeCard reject an amount below zero with a RangeError, and keep every caller working.';
// The hooks Connect writes for Claude Code (the spec's section 6)
const HOOKS = {
  hooks: {
    PostToolUse: [{
      matcher: 'Read|Edit|Write',
      hooks: [{
        type: 'mcp_tool',
        server: 'shadowgit',
        tool: 'facts_for_hooks',
        timeout: 5,
        input: { event: '${hook_event_name}', tool: '${tool_name}', file: '${tool_input.file_path}', agent: '${agent_id}' },
      }],
    }],
  },
};
/** Where the stream of each run goes, to read what reached the model. */
const STREAMS = process.env.EVAL_STREAMS;

/** The facts requests and the blocks delivered, in the order the app got them. */
const factsOrder = (app: FakeApp) =>
  app.requests.flatMap(({ path: route, body }) => (route === '/map/facts' ? [`asked ${String(body.moment)}`] : route === '/map/facts/delivered' ? [`delivered ${String(body.moment)}`] : []));

let passed = 0;
for (let i = 1; i <= RUNS; i++) {
  const app = await startFakeApp();
  // The read facts of charge.ts, which other areas use; any other file's say nothing
  Object.defineProperty(app.factsAnswer, 'read', {
    get: () => (JSON.stringify(app.requestsTo('/map/facts').at(-1) ?? {}).includes('src/billing/charge.ts') ? MAP_ANSWERS.factsRead : MAP_ANSWERS.factsReadQuiet),
  });
  app.mapAnswer.context = MAP_ANSWERS.contextLines;
  try {
    const project = makeProject('webshop', MAP_PROJECT, ago(2 * 24 * 60));
    const stdout = await runClaude({ prompt: TASK, project, app, timeoutMs: 420_000, args: STREAM_ARGS, settings: HOOKS });
    if (STREAMS) fs.writeFileSync(path.join(STREAMS, `facts-run-${i}.jsonl`), stdout);
    const { calls, cost } = readStream(stdout);
    const order = factsOrder(app);
    const firstEdit = order.indexOf('asked edit');
    const readBlock = order.indexOf('delivered read');
    const ok = readBlock !== -1 && firstEdit !== -1 && readBlock < firstEdit && order.includes('delivered edit');
    if (ok) passed++;
    console.log(`run ${i}: ${ok ? 'PASS' : 'FAIL'} facts=${order.join(' → ') || 'none'} cost=$${cost.toFixed(2)}`);
    console.log(`  tools: ${calls.map((call) => call.name.replace('mcp__shadowgit__', 'shadowgit:')).join(' → ') || 'none'}`);
  } catch (error) {
    console.log(`run ${i}: error ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  } finally {
    await app.close();
    removeTempDirs();
  }
}
console.log(`\n${passed} of ${RUNS} runs had the read facts before the first edit and the edit facts after it (pass at ${PASS_AT})`);
process.exitCode = passed >= Math.min(PASS_AT, RUNS) ? 0 : 1;
