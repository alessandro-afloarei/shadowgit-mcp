import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createFactsMemory, factsForHooks, patchPaths, type FactsMemory } from '../src/tools/facts.js';
import { MAP_ANSWERS, MAP_PROJECT, RULES_ANSWERS, closedAppUrl, startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { makeProject, removeTempDirs, restoreEnv, shadowGit, snapshot, tempDir, textOf, useStorage } from './helpers/fixtures.js';

let project: string;
let other: string;
let app: FakeApp;
let memory: FactsMemory;

const AI = 'Claude Code';
const file = (name: string) => path.join(project, name);

/** The context a hook's answer adds, or null for empty text. */
function context(result: CallToolResult): string | null {
  expect(result.isError).not.toBe(true);
  const text = textOf(result);
  if (text === '') return null;
  const answer = JSON.parse(text) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(answer.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  return answer.hookSpecificOutput.additionalContext;
}

const read = (name: string, agent?: string | null) => factsForHooks(memory, { event: 'PostToolUse', tool: 'Read', file: file(name), agent }, AI);
const edit = (name: string, agent?: string | null) => factsForHooks(memory, { event: 'PostToolUse', tool: 'Edit', file: file(name), agent }, AI);

/** The edit fixture with its first symbol changed by `change`. */
function editWith(change: Record<string, unknown>): object {
  const answer = structuredClone(MAP_ANSWERS.factsEdit) as { symbols: Record<string, unknown>[] };
  answer.symbols = [{ ...answer.symbols[0], ...change }];
  return answer;
}

beforeAll(async () => {
  project = makeProject('webshop', MAP_PROJECT);
  other = makeProject('admin', { 'src/admin.ts': 'export const admin = 1;\n' });
  useStorage([{ name: 'webshop', path: project }, { name: 'admin', path: other }]);
  app = await startFakeApp();
});

afterAll(async () => {
  restoreEnv();
  await app.close();
  removeTempDirs();
});

beforeEach(() => {
  process.env.CLAUDE_PROJECT_DIR = project;
  app.requests.length = 0;
  app.factsRoutes = true;
  app.factsStatus = 200;
  app.factsAnswer = { read: MAP_ANSWERS.factsRead, edit: MAP_ANSWERS.factsEdit };
  memory = createFactsMemory();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('facts_for_hooks after a read', () => {
  it('says which areas use the file it read, as the hook answers', async () => {
    expect(context(await read('src/billing/charge.ts'))).toBe(
      [
        "ShadowGit's map (snapshot c22ec972, 2026-11-12T10:53:22+01:00): src/billing/charge.ts is in the \"billing\" area, layer billing.",
        'Used from other areas: chargeCard (line 5) by "api" (1) and "jobs" (1).',
      ].join('\n'),
    );
    expect(app.requestsTo('/map/facts').at(-1)).toEqual({ repoPath: project, aiTool: AI, moment: 'read', files: ['src/billing/charge.ts'] });
  });

  it('says nothing for a file only its own area uses', async () => {
    app.factsAnswer.read = MAP_ANSWERS.factsReadQuiet;
    expect(context(await read('src/billing/format.ts'))).toBeNull();
  });

  it('quotes a rule that holds for the file', async () => {
    app.factsAnswer.read = RULES_ANSWERS.factsRead;
    expect(context(await read('src/jobs/report.ts'))).toContain(
      'A rule holds for this file, quoted from .shadowgit-rules: "src/jobs never depends on src/api" because "jobs read the database through src/db".',
    );
  });

  it('says a file once to each agent, the main thread being one however its id comes', async () => {
    expect(context(await read('src/billing/charge.ts'))).not.toBeNull();
    for (const agent of [undefined, null, '', '${agent_id}']) expect(context(await read('src/billing/charge.ts', agent)), String(agent)).toBeNull();
    expect(context(await read('src/billing/charge.ts', 'agent-a1'))).not.toBeNull();
    expect(app.requestsTo('/map/facts')).toHaveLength(2);
  });

  it('stays under 600 characters, the symbols past it counted', async () => {
    const byArea = Array.from({ length: 12 }, (_, at) => ({ area: `an area named for what it holds, number ${at}`, count: at + 1 }));
    const answer = structuredClone(MAP_ANSWERS.factsRead) as { files: [{ usedFrom: object }] };
    answer.files[0].usedFrom = { items: Array.from({ length: 6 }, (_, at) => ({ name: `symbol${at}`, line: at + 1, byArea })), total: 20 };
    app.factsAnswer.read = answer;
    const said = context(await read('src/billing/charge.ts'));
    expect(said?.length).toBeLessThanOrEqual(600);
    expect(said).toContain('more symbols');
  });
});

describe('facts_for_hooks after an edit', () => {
  it("says what changed against the conversation's baseline, and each dependent where the change can break it", async () => {
    const baseline = shadowGit(project, ['rev-parse', 'HEAD']);
    expect(context(await edit('src/billing/charge.ts'))).toBe(
      [
        "ShadowGit's map: src/billing/charge.ts compared with snapshot c22ec972, the newest when this conversation began.",
        '- chargeCard (line 5): its signature changed. 2 depend on it:',
        '  - checkout, src/api/checkout.ts:7: "return chargeCard(cartTotal(total));"',
        "  - retryFailedCharges, src/jobs/retry.ts:5, its file changed since the map's snapshot",
        '- formatAmount (line 1): its code changed. 1 depends on it, from "billing" (1).',
      ].join('\n'),
    );
    expect(app.requestsTo('/map/facts').at(-1)).toEqual({ repoPath: project, aiTool: AI, moment: 'edit', since: baseline, files: ['src/billing/charge.ts'] });
  });

  it('keeps its baseline as snapshots land, and says a fact once', async () => {
    const baseline = shadowGit(project, ['rev-parse', 'HEAD']);
    await edit('src/billing/charge.ts');
    snapshot(project, { 'src/billing/charge.ts': `${MAP_PROJECT['src/billing/charge.ts']}// later\n` }, 'Later');
    expect(context(await edit('src/billing/charge.ts'))).toBeNull();
    expect(app.requestsTo('/map/facts').at(-1)).toMatchObject({ since: baseline });
  });

  it.each([
    ['a comment', { change: 'comments', signature: false }],
    ['spacing', { change: 'spacing', signature: false }],
    ['an added symbol', { delta: 'added', baseLine: null, signature: null, wasExported: null, dependentCount: 0, dependentsByArea: [], dependents: undefined }],
    ['a symbol nothing depends on', { dependentCount: 0, dependentsByArea: [], dependents: { items: [], total: 0 } }],
  ])('says nothing for %s', async (_name, change) => {
    app.factsAnswer.edit = editWith(change);
    expect(context(await edit('src/billing/charge.ts'))).toBeNull();
  });

  it.each([
    ['removed', { delta: 'removed', line: null, signature: null, exported: false }, '- chargeCard (line 5): removed. 2 depend on it:'],
    ['no longer exported', { signature: false, exported: false }, '- chargeCard (line 5): no longer exported. 2 depend on it:'],
  ])('lists the dependents of a symbol %s', async (_name, change, line) => {
    app.factsAnswer.edit = editWith(change);
    const said = context(await edit('src/billing/charge.ts'));
    expect(said).toContain(line);
    expect(said).toContain('  - checkout, src/api/checkout.ts:7:');
  });

  it('quotes a rule the edit adds a link of, once', async () => {
    app.factsAnswer.edit = RULES_ANSWERS.factsEdit;
    const rule = 'It adds a link a rule names, quoted from .shadowgit-rules: "src/jobs never depends on src/api" because "jobs read the database through src/db": "src/jobs/report.ts imports src/api/users.ts".';
    expect(context(await edit('src/jobs/report.ts'))).toContain(rule);
    expect(context(await edit('src/jobs/report.ts'))).toBeNull();
  });

  it('stays under 2,000 characters, the dependents and symbols past it counted', async () => {
    type Symbol = { name: string; dependents: { items: [object, ...object[]]; total: number } };
    const [first] = (structuredClone(MAP_ANSWERS.factsEdit) as { symbols: [Symbol, ...Symbol[]] }).symbols;
    const symbols = Array.from({ length: 6 }, (_, at) => ({ ...first, name: `chargeCard${at}`, dependents: { items: Array.from({ length: 8 }, () => first.dependents.items[0]), total: 30 } }));
    app.factsAnswer.edit = { ...MAP_ANSWERS.factsEdit, symbols };
    const said = context(await edit('src/billing/charge.ts'));
    expect(said?.length).toBeLessThanOrEqual(2_000);
    expect(said).toContain('get_code_context lists them');
  });

  it("asks for every path of a Codex patch, a moved file by both names, with Codex's CRLF", () => {
    const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@', '-x', '+y', '*** Update File: src/old.ts', '*** Move to: src/new.ts', '*** Add File: src/b.ts', '+z', '*** Delete File: src/c.ts', '*** End Patch'].join('\r\n');
    expect(patchPaths(patch)).toEqual(['src/a.ts', 'src/old.ts', 'src/new.ts', 'src/b.ts', 'src/c.ts']);
  });

  it("answers a Codex patch with the facts of its files, in the project of its first path", async () => {
    const patch = ['*** Begin Patch', '*** Update File: src/billing/charge.ts', '*** Delete File: src/billing/format.ts', `*** Update File: ${path.join(other, 'src/admin.ts')}`, '*** End Patch'].join('\n');
    expect(context(await factsForHooks(memory, { event: 'PostToolUse', tool: 'apply_patch', patch }, 'Codex'))).toContain('- chargeCard (line 5): its signature changed.');
    expect(app.requestsTo('/map/facts').at(-1)).toMatchObject({ repoPath: project, files: ['src/billing/charge.ts', 'src/billing/format.ts'] });
  });
});

describe("facts_for_hooks finds each file's project", () => {
  it('through a link to the project folder', async () => {
    const link = path.join(tempDir('link'), 'webshop');
    fs.symlinkSync(project, link);
    expect(context(await factsForHooks(memory, { tool: 'Read', file: path.join(link, 'src/billing/charge.ts') }, AI))).not.toBeNull();
    expect(app.requestsTo('/map/facts').at(-1)).toMatchObject({ repoPath: project, files: ['src/billing/charge.ts'] });
  });

  it("in a second tracked project, against that project's own baseline", async () => {
    const baseline = shadowGit(other, ['rev-parse', 'HEAD']);
    await factsForHooks(memory, { tool: 'Edit', file: path.join(other, 'src/admin.ts') }, AI);
    expect(app.requestsTo('/map/facts').at(-1)).toMatchObject({ repoPath: other, since: baseline, files: ['src/admin.ts'] });
  });

  it('and says nothing, asking nothing, for a file in no tracked project', async () => {
    expect(context(await factsForHooks(memory, { tool: 'Read', file: path.join(tempDir('elsewhere'), 'a.ts') }, AI))).toBeNull();
    expect(app.requestsTo('/map/facts')).toEqual([]);
  });
});

describe('facts_for_hooks when the app has nothing to say', () => {
  it('answers empty text, never an error, with the app closed, a map still drawing, a refused request or an older app', async () => {
    vi.stubEnv('SHADOWGIT_SESSION_API', await closedAppUrl());
    expect(context(await read('src/billing/charge.ts'))).toBeNull();
    vi.unstubAllEnvs();
    for (const status of [202, 400, 409] as const) {
      app.factsStatus = status;
      expect(context(await edit('src/billing/charge.ts')), String(status)).toBeNull();
    }
    app.factsStatus = 200;
    app.factsRoutes = false;
    expect(context(await read('src/billing/charge.ts'))).toBeNull();
  });

  it("answers the app's failure as an error", async () => {
    app.factsStatus = 500;
    const result = await read('src/billing/charge.ts');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('ShadowGit: The facts took longer than 4.5 s');
  });

  it('says nothing after a tool the hooks do not follow', async () => {
    expect(context(await factsForHooks(memory, { tool: 'Grep', file: file('src/billing/charge.ts') }, AI))).toBeNull();
    expect(app.requestsTo('/map/facts')).toEqual([]);
  });
});

describe('facts_for_hooks tells the app what it delivered', () => {
  it('by the counts of each block it answers', async () => {
    await edit('src/billing/charge.ts');
    await vi.waitFor(() =>
      expect(app.requestsTo('/map/facts/delivered').at(-1)).toEqual({
        repoPath: project,
        aiTool: AI,
        moment: 'edit',
        symbols: 2,
        dependents: 2,
        rules: 0,
        chars: expect.any(Number),
        ms: expect.any(Number),
      }),
    );
    app.factsAnswer.read = MAP_ANSWERS.factsReadQuiet;
    await read('src/billing/format.ts');
    expect(app.requestsTo('/map/facts/delivered')).toHaveLength(1);
  });
});
