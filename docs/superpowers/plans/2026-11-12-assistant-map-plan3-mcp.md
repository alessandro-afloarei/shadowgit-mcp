# The map at work, plan 3: shadowgit-mcp-server 2.11.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant gets ShadowGit's map without asking: `get_code_context` loads from the first prompt, the instructions carry the project's outline, and a new `facts_for_hooks` tool answers Claude Code's and Codex's `PostToolUse` hooks with what the map says of each file the assistant reads or edits. `get_code_context` shows each dependent's line. `npm run eval:facts` measures the hooks with a real Claude Code.

**Architecture:**
- The app (shadowgit-app main at 21042bb, plan 2) serves what the server uses:
  - `GET /api/map/outline?repoPath` answers as `GET /api/map` does (`mapAsOf`, `summary`, `rules`, `rulesFailure`, `docs`), from the map kept, never waiting for a build: 202 while the first map draws. It is not the assistant at work.
  - `POST /api/map/facts { repoPath, moment: 'read', files }` (1 to 5 project paths) answers `{ mapAsOf, files: ReadFacts[], rules, rulesFailure }`.
  - `POST /api/map/facts { repoPath, moment: 'edit', since, files }` (1 to 20) answers `{ since: { snapshot, time }, mapAsOf, symbols: EditedWithDependents[], rules: RuleCheck, rulesFailure, skipped }` within 4.5 s, a 500 past it.
  - Both: 400 for a bad request or a `since` the history lacks, 202/409 while no map is kept, 404 `Not found` in an app older than 0.7.0.
  - `POST /api/map/facts/delivered { repoPath, aiTool, moment, symbols, dependents, rules, chars, ms }` sends `agent_facts_delivered`.
  - `POST /api/map/context` gives each listed dependent `use: { line, text } | { changedSince: true }` when found.
- The server mirrors these shapes in zod, tested against answers captured from the real app. Hooks reach it as `mcp_tool` calls; it answers a hook with the hook's JSON, or empty text.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/server` v2 (`registerTool` takes `_meta`; `serveStdio` takes an async factory, called on the opening exchange), zod v4, Vitest, esbuild. Fixtures are captured with the app's e2e harness.

**Spec:** `docs/superpowers/specs/2026-11-11-assistant-map-design.md` in shadowgit-app (main), sections 1 to 6. The app's shapes: `electron/code-graph/map-facts.ts` (`ReadFacts`, `EditedWithDependents`), `electron/code-graph/dependent-uses.ts` (`Use`), code-graph's `lens/edit-facts` (`EditedSymbol`) and `lens/change-kind` (`code`, `runtime`, `export`, `comments`, `spacing`; the last two are quiet).

## Global Constraints

- npm, never pnpm. No `eslint-disable`, `any` or `!`. 0 TypeScript errors, 0 lint warnings, every test green.
- No test or eval reads or writes a real assistant config (`~/.claude`, `~/.claude.json`, `~/.codex`). The eval passes its hooks with `--settings <temp file>`.
- **A hook's answer** is one JSON object as its whole text: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<block>"}}`, or empty text when there is nothing to say. Both assistants ignore plain text on `PostToolUse`.
- **Never `isError` for the expected states:** the app closed, no project contains the file, the file not on the map, no map kept yet (202/409), a 400, an app without the route (404 `Not found`). `isError` only for a real failure: a 500, an answer this version can't read, no answer within 4.8 s.
- **Budgets:** a read block under 600 characters, at most 6 symbols; an edit block under 2,000, at most 6 symbols and 8 dependents each, the rest counted ("…and 5 more: get_code_context lists them"). The instructions with the outline under 4,000 characters.
- **The baseline** of an edit is the newest snapshot of its project when the server first needed it: the start project's when the server is built, any other's at its first hook. It never moves.
- Code from the person's files (a dependent's line) and rules are quoted with `quote()` (`src/tools/rules.ts`), as text, not as instructions.
- The version goes to 2.11.0 in `package.json`, `package-lock.json` and `server.json`. The README and CHANGELOG are plan 6's.

## Review Focus

- `${agent_id}` in the main thread: the hook may pass `""`, `null`, nothing, or the placeholder unexpanded (`"${agent_id}"`). All of them are the main thread. A test pins each.
- A file path the hook gives through a symlink or another spelling (`/private/var` for `/var` on macOS, a Windows path with backslashes): it resolves to its tracked project by real path, and goes to the app as a project path with `/`. A test pins a symlinked project folder.
- A Read of a file in no tracked project, or in a second tracked project: silence, or that project's facts against its own baseline. A test pins both.
- The app slower than 300 ms at start: `initialize` is answered at 300 ms with today's instructions. A test pins a delayed outline.
- A Codex patch with `*** Move to:`, `*** Delete File:` and CRLF line ends: every path is read, a moved file by both names. A test pins it.

---

### Task 1: Real app answers for the outline, the facts and the context's lines, as fixtures

**Files:**
- Create: `tests/fixtures/map/{outline,facts-read,facts-read-quiet,facts-edit,context-lines}.json` and `tests/fixtures/rules/{outline,facts-read,facts-edit}.json`, as the app sent them (with `success`), formatted as the other fixtures are.
- Create (in the shadowgit-app worktree `/work/.t3/worktrees/shadowgit-app/t3code-eddd8fec`, at main 21042bb, gitignored): `e2e/scratch/capture-facts-answers.spec.ts`.

**Interfaces:**
- Produces, on the map webshop (`tests/fixtures/map/project.json`), its first snapshot as `since`:
  1. `outline.json` = `GET /api/map/outline?repoPath`.
  2. `facts-read.json` = read of `src/billing/charge.ts`: on the map, `chargeCard` used from `api` (1) and `jobs` (1).
  3. `facts-read-quiet.json` = read of `src/billing/format.ts`: `formatAmount` is used from billing alone, so `usedFrom.total` is 0.
  4. `facts-edit.json`: on disk, `chargeCard(amount: number, currency = 'EUR')` in charge.ts (signature), `formatAmount`'s body in format.ts (code), and a comment line added at the top of `src/jobs/retry.ts`, which is not asked. Then an edit request for charge.ts and format.ts. Expected:
     - `chargeCard`: `signature: true`, dependents `checkout` with `use.line` 7 and `retryFailedCharges` with `use: { changedSince: true }`;
     - `formatAmount`: `change: 'code'`, `dependentCount` 1, no `dependents`.
  5. `context-lines.json` = `POST /api/map/context { symbols: [{ name: 'chargeCard' }] }`, after the files are put back: each dependent with its `use`.
- On the rules webshop (`tests/fixtures/rules/project.json`):
  6. `outline.json` with the rule.
  7. `facts-read.json` = read of `src/jobs/report.ts`, for which the rule holds.
  8. `facts-edit.json` = an edit making report.ts import `countUsers` from `../api/users` and call it: `rules.matches` names the rule.

- [ ] **Step 1: Write the capture spec.** It writes each project, adds it, waits for the map (`GET /api/map` 200), asks each route with `fetch` on `http://127.0.0.1:45289/api`, `expect`s the facts above before it saves, and writes to `/work/.t3/worktrees/shadowgit-mcp-server/assistant-map/tests/fixtures/…`.
- [ ] **Step 2: Run** `E2E_SCRATCH=1 E2E_ARTIFACTS_DIR=/work/artifacts npm run test:e2e -- scratch/capture-facts-answers` in the app worktree (after `pgrep -af "[x]vfb-run|[p]laywright test -c e2e"` shows the slot free). Expected: PASS, eight files written. Then nothing left running.
- [ ] **Step 3: Delete the scratch spec. Commit the fixtures:** `test: real app answers for the outline, the facts and the dependents' lines`.

### Task 2: The mirror reads the outline, the facts and a dependent's use

**Files:**
- Modify: `src/map-shapes.ts` (export `AreaCount`, `DependentRef`; `DependentRef`'s two members gain `use: Use.optional()`), `src/session-api.ts`, `tests/helpers/fake-app.ts`.
- Create: `src/fact-shapes.ts`.
- Test: `tests/session-api.test.ts`.

**Interfaces:**
- Produces:
  - `Use = z.union([z.object({ line: z.number().int(), text: z.string() }), z.object({ changedSince: z.literal(true) })])` in `map-shapes.ts`.
  - `src/fact-shapes.ts`: `ReadFacts`, `FactsRead`, `EditedSymbol`, `FactsEdit`, mirroring the app's types (Architecture). Open values (`delta`, `change`) are strings.
  - `src/session-api.ts`:
    - `readOutline(repoPath: string): Promise<z.infer<typeof SummaryRead> | null>`: a GET with a 300 ms timeout; null for any status but 200 and for the app closed or late.
    - `readFileFacts(body: { repoPath: string; aiTool: string; files: string[] }): Promise<z.infer<typeof FactsRead> | null>` (moment `read`) and `readEditFacts(body: { repoPath: string; aiTool: string; since: string; files: string[] }): Promise<z.infer<typeof FactsEdit> | null>` (moment `edit`): 4.8 s timeout, `accept: [202, 400, 409]` → null, 404 → `APP_WITHOUT_FACTS` thrown.
    - `sendFactsDelivered(body: { repoPath: string; aiTool: string; moment: 'read' | 'edit'; symbols: number; dependents: number; rules: number; chars: number; ms: number }): Promise<void>`.
    - `export const APP_WITHOUT_FACTS = 'This version of ShadowGit has no facts for hooks. Ask the user to update the ShadowGit app.'`
  - The fake app: `factsRoutes`, `outlineAnswer`, `outlineDelayMs`, `factsAnswer: { read, edit }`, `factsStatus`, and records `/map/facts/delivered` bodies.

- [ ] **Step 1: Write the failing tests:** each new fixture parses through its shape (`FactsRead`, `FactsEdit`, `SummaryRead` for the outlines, `ContextRead` for `context-lines.json` with a `use` on each dependent); `readOutline` gives null for 202, for a closed app and for an answer 400 ms late; `readFileFacts` and `readEditFacts` give null for 202, 400 and 409 and throw `APP_WITHOUT_FACTS` on 404. The 4.8 s timeout is `request()`'s, already tested for other routes.
- [ ] **Step 2: Run** `npx vitest run tests/session-api.test.ts`. Expected: FAIL, the functions and shapes missing.
- [ ] **Step 3: Implement** the shapes, the three functions and the fake app's routes.
- [ ] **Step 4: Run** it again. Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit:** `feat: read the app's outline and facts, and a dependent's use`.

### Task 3: `get_code_context` loads upfront and shows each dependent's line

**Files:**
- Modify: `src/tools/map.ts`, `src/server.ts` (`INSTRUCTIONS`).
- Test: `tests/tools-map.test.ts`, `tests/e2e.test.ts`.

**Interfaces:**
- Produces: `get_code_context` registered with `_meta: { 'anthropic/alwaysLoad': true }`, and no other tool with it. `INSTRUCTIONS` without "(load it with tool search if it is deferred)".
- A target's dependents, and the landing's, are bullets under their count line ("2 depend on chargeCard, from "api" (1) and "jobs" (1):"), each:
  - with a line: `- checkout (src/api/checkout.ts:5, calls), line 7: "return chargeCard(cartTotal(total));"`;
  - changed since: `- retryFailedCharges (src/jobs/retry.ts:5, calls): its file changed since the map's snapshot`;
  - otherwise as `ref()` writes it today, the cap's "…and N more" line kept.
- The description adds: "each dependent with the line where it uses it, as the file is on disk".

- [ ] **Step 1: Write the failing tests:** on `context-lines.json`, the text holds the bullet with checkout's quoted line; a `changedSince` variant of it gives the changed-since bullet; `context.json` (no `use`) still lists its dependents. In `e2e.test.ts`, `tools/list` gives `get_code_context` `_meta['anthropic/alwaysLoad'] === true` and every other tool none; the instructions no longer hold "tool search".
- [ ] **Step 2: Run** `npm test`. Expected: FAIL on those.
- [ ] **Step 3: Implement.** Update the snapshot files the format change moves, reading each diff.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. The description stays under 4,096 characters (a test asserts it).
- [ ] **Step 5: Commit:** `feat: get_code_context loads upfront, with each dependent's line`.

### Task 4: The outline in the instructions

**Files:**
- Create: `src/outline.ts`.
- Modify: `src/server.ts` (`buildServer(outline: string | null = null)`), `src/index.ts`.
- Test: `tests/outline.test.ts`, `tests/e2e.test.ts`.

**Interfaces:**
- Produces:
  - `outlineText(repo: string, read: z.infer<typeof SummaryRead>, budget: number): string`. The lines, in order:
    - `This project, webshop, on ShadowGit's map (snapshot 9db22aff, <time>): 19 files, 3 areas, 3 layers.`
    - `Areas: "api" (8 files), "billing" (6), "jobs" (5).` — at most 12.
    - `Most links: "api" → "billing" (3 calls and imports), …` — at most 8.
    - `Processes: <label>: "api" → "billing"; …` — at most 6.
    - `Rules, quoted from .shadowgit-rules: "<text>" because "<because>"; …` — at most 8, only when the read has rules.
    - `get_map and get_docs read more.`
    - Each capped list ends "and N more" from its `total`. Over `budget`, every cap is halved until the text fits; the first and last lines always stay.
  - `outlineAtStart(): Promise<string | null>`: the start project (`currentRepo(readRepos())`), `readOutline`, `outlineText` with the budget `4_000 - INSTRUCTIONS.length - 1`; null when there is no project or no answer. A shape it can't read is null, and written to stderr.
  - `index.ts` starts `outlineAtStart()` as the process starts, and `serveStdio(async () => buildServer(await outline))`.

- [ ] **Step 1: Write the failing tests:** `outlineText` on both outline fixtures (the lines above; the rule quoted); caps with "and N more"; a 1,000-character budget halves the caps and keeps the first and last lines. e2e: a fake app answering the outline gives instructions that end with the outline; an app answering 202, a closed app, and an outline 500 ms late each give today's instructions, the late one with `initialize` answered within 1 s.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: the project's outline in the instructions, read as the server starts`.

### Task 5: `facts_for_hooks`

**Files:**
- Create: `src/tools/facts.ts`.
- Modify: `src/repos.ts` (export `projectOfFile`), `src/tools/rules.ts` (export `ruleLine`), `src/server.ts` (`registerFacts`).
- Test: `tests/tools-facts.test.ts`, `tests/e2e.test.ts`.

**Interfaces:**
- Consumes: `readFileFacts`, `readEditFacts`, `sendFactsDelivered`, `APP_WITHOUT_FACTS`, `AppNotRunningError` (Task 2); `runGit` for a baseline (`rev-parse HEAD`).
- Produces:
  - `projectOfFile(file: string): { project: Repo; file: string } | null` in `repos.ts`: the tracked project whose real path contains the file's real path (the deepest), and the file relative to it with `/`. A relative path resolves from the start directory.
  - `HookInput = z.object({ event, tool, file, agent, patch })`, each `z.string().nullish()`; a value that is empty or still holds `${` counts as absent. `agent` absent is the main thread.
  - `createFactsMemory(): FactsMemory`: what was said (`Set<string>`) and the baselines (`Map<string, Promise<string | null>>`), the start project's read as it is made.
  - `factsForHooks(memory: FactsMemory, input: z.infer<typeof HookInput>, aiTool: string): Promise<CallToolResult>`.
  - `patchPaths(patch: string): string[]`: the paths of `*** Update File:`, `*** Add File:`, `*** Delete File:` and `*** Move to:` lines, in order, CRLF read as LF.
  - `registerFacts(server: McpServer)`: one memory per server; the description says it answers ShadowGit's Read and Edit hooks and points to `get_code_context` for direct questions.
- **Moments:** `tool` `Read` with a `file` is a read. `Edit`, `Write`, `MultiEdit` with a `file`, or `apply_patch` (or any input with a `patch`) is an edit. Anything else is silent.
- **A read** asks for the one file once per agent and file (remembered on any 200 answer). Its block, only when another area uses the file's symbols or a rule holds for it:
  ```
  ShadowGit's map (snapshot 9db22aff, <time>): src/billing/charge.ts is in the "billing" area, layer billing.
  Used from other areas: chargeCard (line 5) by "api" (1) and "jobs" (1).
  A rule holds for this file, quoted from .shadowgit-rules: "<text>" because "<because>".
  ```
  Over 600 characters, the symbols listed go 6, 3, 1, the rest counted.
- **An edit** asks for its files (a patch's in the project of its first path, at most 20) against the baseline. Each changed symbol says one fact, the first that holds: removed; its signature changed; no longer exported; its code changed. `comments` and `spacing` changes, added symbols, symbols nothing depends on, and a fact already said to this agent for this file and symbol are silent. For the first three facts the dependents are listed:
  ```
  ShadowGit's map: src/billing/charge.ts compared with snapshot 9db22aff, the newest when this conversation began.
  - chargeCard (line 5): its signature changed. 2 depend on it:
    - checkout, src/api/checkout.ts:7: "return chargeCard(cartTotal(total));"
    - retryFailedCharges, src/jobs/retry.ts:5, changed since that snapshot
  - formatAmount (line 1): its code changed. 1 depends on it, from "billing" (1).
  It adds a link a rule names, quoted from .shadowgit-rules: "<text>" because "<because>": "<link>".
  ```
  A file dependent reads `top-level code in <file>` (calls) or `<file> imports it`. Rule matches, at most 3, are said once per agent and rule. Over 2,000 characters, the dependents listed go 8, 4, 2, 0 (counted by area), then the symbols 6, 3, 1.
- **After a block**, `sendFactsDelivered` with the block's counts (symbols, dependent lines, rule lines), its `chars` and its `ms`, not awaited; a failure goes to stderr.
- **Errors:** the Global Constraints' list. `isError` text is the error's message.

- [ ] **Step 1: Write the failing tests** in `tests/tools-facts.test.ts`, on the fixtures:
  - the read block of `facts-read.json`, as the hook's JSON; `facts-read-quiet.json` gives empty text; the rules read gives the rule line;
  - the same file read again by the main thread is not asked; by agent `a1` it is;
  - `agent` `""`, `null`, absent and `"${agent_id}"` are one agent;
  - the edit block of `facts-edit.json`, its `since` the baseline read when the memory was made, unchanged by a newer snapshot made after; a second identical edit is silent;
  - a `comments` change, an added symbol, a symbol with no dependents: silent; removed and no longer exported (variants of the fixture) list the dependents;
  - the rules edit names the rule once;
  - a patch with Update, Add, Delete, Move to and CRLF asks for every path; the Review Focus cases (symlinked project, second project, no project);
  - the app closed, 202, 400, 404: empty text, not `isError`; 500: `isError`;
  - after a block, the fake app gets `/map/facts/delivered` with its counts (`vi.waitFor`);
  - a 30-dependent edit stays under 2,000 characters, a 20-area read under 600.
  - In `e2e.test.ts`: with the app closed, the spawned server answers a Read and an Edit hook with empty text and no `isError`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, `facts.ts` missing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint`. Expected: all green.
- [ ] **Step 5: Commit:** `feat: facts_for_hooks, the map's facts as the assistant reads and edits`.

### Task 6: `eval:facts`, and `eval:map` again

**Files:**
- Create: `scripts/eval-facts.ts`.
- Modify: `package.json` (`"eval:facts": "npm run build && tsx scripts/eval-facts.ts"`), `scripts/claude.ts` (`runClaude` takes `settings?: object`, written to a temp file and passed as `--settings`).

**Interfaces:**
- Consumes: the fixtures (Task 1), `runClaude`, `readStream`, `STREAM_ARGS`.
- The eval: eval:map's task on the map webshop ("Make chargeCard reject an amount below zero with a RangeError, and keep every caller working."), with the Claude Code hooks of the spec's section 6 in `--settings`. The fake app answers the outline, the read facts of charge.ts (`facts-read.json`, the quiet answer for other files), the edit facts (`facts-edit.json`) and the context (`context-lines.json`). A run passes when the fake app received a `delivered` read block before its first edit facts request, and a `delivered` edit block. If the stream carries the hooks' context, the run also checks the block's first line is in it. 5 runs, pass at 4; the account and cost are reported.

- [ ] **Step 1: Write the eval.** Run it once (`RUNS=1`) and read the stream: does `${agent_id}` reach the server for the main thread as empty, missing or the placeholder? Does the stream show the hooks' context? Ledger what it shows.
- [ ] **Step 2: Run** `npm run eval:facts` with the eval account (`claude-personal3`). Expected: 4 of 5 or better.
- [ ] **Step 3: Run** `npm run eval:map`. Expected: 4 of 5 or better (the description and instructions changed).
- [ ] **Step 4: Commit:** `feat: eval:facts, the hooks' facts with a real Claude Code`.

### Task 7: Under 300 ms on the app's own map, and 2.11.0

**Files:**
- Modify: `package.json`, `package-lock.json`, `server.json` (2.11.0).
- Create, then delete: `e2e/scratch/facts-measure.spec.ts` in the app worktree, and `scripts/measure-facts.ts` here (not committed).

- [ ] **Step 1: Measure.** The app spec launches the app on an archive of the app repository (as `map-agent.spec.ts:171` does), waits for its map, writes `{ storage, project }` to `/work/artifacts/assistant-graph-2026-11-11/measure-ready.json`, and waits for `measure-done.json`. The script connects to the built server (`tests/helpers/client.ts`, `SHADOWGIT_STORAGE_DIR`, `SHADOWGIT_SESSION_API=http://127.0.0.1:45289/api`, `CLAUDE_PROJECT_DIR`) and calls `facts_for_hooks` for 20 reads of distinct files and 10 edits (a body edit to a much-used function each, put back after). Expected: p95 under 300 ms for both; the numbers go in the ledger and the PR.
- [ ] **Step 2: Bump** to 2.11.0 (`npm version 2.11.0 --no-git-tag-version`, then `server.json` by hand). `npm test`. Expected: PASS (`release.test.ts` keeps them in step).
- [ ] **Step 3: Commit:** `chore: 2.11.0`.
