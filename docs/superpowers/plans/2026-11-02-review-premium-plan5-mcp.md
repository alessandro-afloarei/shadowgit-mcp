# Review that finishes, plan 5: shadowgit-mcp-server 2.7.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent reads the review comments the person sent from ShadowGit, changes only what each asks, and replies to each. Alongside, the docs step and `write_docs` use the app's new docs routes (living docs follow-up 2). `npm run eval:comments` measures the comments flow with a real Claude Code.

**Architecture:**
- The app (shadowgit-app main, plan 2 of the review design, at edad435) serves three things the server uses:
  - `GET /api/comments?repoPath` answers `{ sends: OpenSend[] }`, where an `OpenSend` is a `SendRecord` whose `comments` are `CommentView`s.
  - `POST /api/comments/reply { repoPath, id, text, author? }` answers `{ reply: { by, text, at, snapshot } }`.
    - 404 `There is no open comment #N…` for a comment that was never sent or is resolved;
    - 400 for empty text, text over 1,000 characters, or a full record.
  - `POST /api/session/start` adds `openComments: N` when N > 0.
- Apps older than 0.4.0 answer every unknown route with 404 `{ success: false, error: 'Not found' }`.
- The docs routes:
  - `GET /api/docs` takes `base` and `head`, a range named as for `/api/lens`;
  - `POST /api/docs` checks each page on its own. It answers `left: [{ page: DocKey | null, why }]` beside `pages`, and 400 only when no page passes.
- The server mirrors these shapes in zod, tested against answers captured from the real app, so that `structuredContent` carries them. The tools' descriptions and the server's instructions say when and how to use them.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/server` v2, zod v4, Vitest, esbuild. Fixtures are captured with the app's e2e harness (Playwright on Electron).

**Spec:** `docs/superpowers/specs/2026-11-01-review-premium-design.md` in shadowgit-app (`/work/.t3/worktrees/shadowgit-app/t3code-eddd8fec`), section 5, with section 2 for what a comment and a Send are.
- The app's shapes are in `electron/core/types/comments.ts`: `CommentRecordSchema`, `SendRecordSchema`, `CommentView`.
- `electron/code-graph/comments-agent.ts` holds `OpenSend` and `ReplyAnswer`; `electron/code-graph/docs-agent.ts` holds `DocsWriteAnswer` and `DocLeft`.
- `src/lib/review-text.ts` holds the clipboard text.

## Global Constraints

- **Older apps.** `get_review_comments` and `reply_to_review_comment` answer, verbatim, when the app has no comment routes: "This version of ShadowGit has no review comments for AI assistants. Ask the user to update the ShadowGit app."
  - For the GET route, any 404 means this.
  - For the reply route, only a 404 whose error is `Not found` does. The route's own 404 passes on the app's reason.
- **Optional fields.** `openComments` and `left` are optional. With an app before 0.4.0, `start_session` and `write_docs` answer as in 2.6.1, and no structured answer gains a key.
- **`start_session`'s sentence**, verbatim from the spec, with the count in the singular for 1:
  - "The person sent 2 review comments on this project. Read them with get_review_comments when they ask you to address their review."
  - "The person sent 1 review comment on this project. …"
  - It never tells the agent to act on them unasked.
- **Rules where the model reads them.** Claude Code shows the model a tool's structured content alone, plus each tool's description and input schema. So what to do with comments goes in descriptions, input `.describe()`s, the instructions, and the structured `next`. It never goes in an output schema or only in text.
- **The words.** ShadowGit's own words describe and never judge. None of these appear in a description, the instructions or any text answer: violation, violates, breaks, forbidden, not allowed, warning, error, bad, circular, should, coupling or risky. `JUDGING` in `tests/helpers/fixtures.ts` checks them.
- **No generated comments, no resolving.** The server reads and replies; it never writes, edits or resolves a comment.
- **Reply text.** 1 to 1,000 characters once trimmed: the app's `COMMENT_LIMITS.reply`.
- **Version.** 2.7.0 in `package.json`, `package-lock.json` and `server.json`. README.md and CHANGELOG.md keep CRLF (`tests/release.test.ts`). The changelog says 2.7.0 needs ShadowGit 0.4.0.
- **Publishing.** The npm publish is Alessandro's, after ShadowGit 0.4.0 ships. Claude makes the tag and the GitHub release after it.
- **House rules.** No `any`, no non-null `!`, no `eslint-disable`. `npm run lint`, `npm run typecheck` and `npm test` stay at 0.

## Calls this plan makes

1. **`get_review_comments`' structured answer** is `{ repo, sends, next? }`. Each Send is `{ id, at, range, unviewed, moreUnviewed, comments }`. Each comment is `{ id, tag, body, anchor, since, replies }`.
   - The record's `version`, `status`, `send`, `created` and `updated` are left out: the agent has no use for them.
   - `next` is "Change only what each comment asks, then reply to each with reply_to_review_comment: #1, #2 and #3." When the project isn't the current one, it starts with `forProject`'s prefix.
   - With no open comment, `next` is absent and `sends` is `[]`.
2. **Its text** is for text-only clients. It mirrors the app's `reviewText`:
   - each Send's header names its range;
   - each comment gives `#id [Tag] place`, its quoted lines (`> `), its words, `Lines changed since, in <short>.` when `since` is set, and each reply;
   - each Send's ledger line follows.
   - A reply reads `<by> at <short>: <text>`, or `<by>, session in progress: <text>`, as the app's card does.
3. **`reply_to_review_comment`** sends `author` = `clientName(server, ctx)`, as `checkpoint` does. It answers `{ repo, id, reply }`.
4. **`start_session`'s structured answer** gains `review?: string`, the sentence above, only when the app answered `openComments` > 0. An already-active session asks the app nothing new and gains nothing.
5. **The instructions** gain one task line, after the docs line: "- The user asks you to address their review, or their ShadowGit review comments: get_review_comments, change only what each comment asks, then reply to each with reply_to_review_comment."
6. **Follow-up 2, the docs step.** `write_lens_words`' docs step reads `GET /api/docs?base&head` for the range of the words, with `DOCS_PROBE_MS`, in place of reading the session's Lens first.
   - Words for any range now get that range's pages.
   - The step names them and says "get_docs with base … and head …, then write_docs".
   - `get_docs` gains `base` (nullable) and `head`. They come together, never with `areas`, `overview`, `all` or `more`, and the server refuses a mix before any request.
7. **Follow-up 2, `write_docs`.** `AppWords` and `bodyWords` go: the app checks each page.
   - `appPage` keeps only the shape checks a flat page needs (area or overview, words or holds) and the plain-paragraph conversion.
   - The app's `left` is listed in the text with the pages `kept: false`, and in the structured answer as `left`.
   - `SUMMARY_MAX` and `BODY_WORDS_MAX` stay in the description.
8. **`eval:comments`** runs on the map webshop (`tests/fixtures/map/project.json`). The fake app answers `GET /api/comments` with the captured `comments/open.json` and stores each reply.
   - The prompt, verbatim: "Address my ShadowGit review comments."
   - A run passes when all of these hold:
     - it called `get_review_comments` before its first edit;
     - it replied to all four comments;
     - `src/api/cart.ts` and `src/api/orders.ts` changed only inside the commented definitions (`shipping`, lines 10–12; `listOrders`, lines 15–17), with the change asked: `100` in `shipping`, and `listOrders` no longer passing `i` unchanged;
     - no other file changed or was created.
   - The eval passes at 8 of 10 (`RUNS`, `PASS_AT = Math.ceil(0.8 * RUNS)`).
9. **`npm run eval`'s phrases** gain "Address my ShadowGit review comments". It passes when `get_review_comments` was called. The README's "What to ask" gains it too.

## Review Focus

1. **An app before 0.4.0.**
   - Both comment tools give the update message.
   - The reply route's own 404 passes on "There is no open comment #N…", never the update message.
   - `start_session` gains no `review`.
   - `write_docs` against an app that answers no `left` reads as before.
   - Covered in Tasks 2 and 3.
2. **A comment with no lines (the whole file), one on removed lines, a `since` and a reply waiting for its snapshot.** The text reads each as the app's card does, and the structured answer carries them unchanged. Covered in Task 3 with `comments/answered.json`.
3. **Another project.** `next` names it, and `reply_to_review_comment` with `repo` replies there. Covered in Task 3.
4. **A reply past 1,000 characters or blank.** The input schema refuses it before any request. Covered in Task 3.
5. **The docs step for a range that isn't the latest session's.**
   - It names that range's pages, and `get_docs` with that `base`/`head` asks the app for the same range.
   - A mix of `base` with `areas` is refused before any request.
   - Covered in Task 4.

---

### Task 1: Real app answers for comments and the docs routes, as fixtures

**Files:**
- Create: `tests/fixtures/comments/{open,answered,start,reply,no-comment}.json` and `tests/fixtures/docs/{range,written-left}.json`. Each is an answer as the app sent it (with `success`), formatted as `tests/fixtures/docs/*.json` are.
- Create (in the shadowgit-app worktree `/work/.t3/worktrees/shadowgit-app/t3code-eddd8fec`, whose tree is main's, gitignored): `e2e/scratch/capture-comment-answers.spec.ts`.

**Interfaces:**
- Produces, all on the map webshop, captured in this order:
  1. Session A, "Add the webshop": `startSession`, write `project.json`'s files, `checkpoint`, `endSession`. Range A is the checkpoint's parent to the checkpoint.
  2. Four comments, saved with `window.shadowGitApi.repo.saveComment`, on range A's head, side `head`:
     - #1 `change` on `src/api/cart.ts` 11–11, symbol `shipping`: "Free shipping starts at 100, not 50."
     - #2 `question` on `src/billing/discount.ts` 4–4, symbol `applyDiscount`: "Why divide by 100 and round again, when the amount is already in cents?"
     - #3 `change` on `src/api/orders.ts` 16–16, symbol `listOrders`: "Number the orders from 1: createOrder(0) gives order id 0."
     - #4 `note` on `src/jobs/cleanup.ts` 11–13, symbol `purgeLogs`: "purgeLogs stays as it is: the nightly job calls it."
  3. Two Sends:
     - #1–#3 sent with range A labelled `This AI session` (`outlineSend` then `sendComments`);
     - #4 sent with range `null`.
  4. `open.json` = `comments(project)`: two Sends, four comments, no replies, every `since` null. Send 1 has a ledger (`unviewed` non-null); Send 2 has `range: null` and `unviewed: null`.
  5. `start.json` = the raw `/session/start` answer of session B, with `openComments: 4`. In session B, the edit of the living-docs capture: `lateFee` in `src/billing/charge.ts`, called from `src/jobs/retry.ts`. Then `checkpoint` and `endSession`.
  6. `range.json` = `docs({ repoPath, base: A.base, head: A.head })`. Its pages are those range A changed, which are not only session B's.
  7. `written-left.json` = `writeDocs` at the newest snapshot with three pages:
     - `src/billing` with a one-sentence summary and a body;
     - `src/jobs` with a 201-character summary;
     - `src/api` with a one-sentence summary and a body.

     It keeps two pages and lists `src/jobs` in `left`, its `why` naming the summary's limit.
  8. `reply.json` = `reply({ repoPath, id: 2, text: 'It rounds a fractional discount to whole cents.', author: 'Claude Code' })` outside a session: `reply.snapshot` is the newest snapshot.
  9. `no-comment.json` = `reply({ repoPath, id: 99, text: 'Done.' })`: 404.
  10. `answered.json` is captured in three steps, then `comments(project)`:
      - an edit of `src/api/orders.ts` line 16 to `createOrder(i + 1)`, then `checkpoint` outside a session;
      - session C, and `reply` to #1 ("Raised the threshold to 100.");
      - `comments(project)`, then `endSession(C)`.

      In it, #3's `since` names the checkpoint, #2's reply has a snapshot, and #1's reply has `snapshot: null`.

- [ ] **Step 1: Write the capture spec**
  - It uses `e2e/support/session-api.ts` (`startSession`, `endSession`, `checkpoint`, `comments`, `reply`, `docs`, `writeDocs`) and IPC through `app.page.evaluate`.
  - `/session/start`'s raw answer is a `fetch` of `http://127.0.0.1:45289/api/session/start`.
  - Before each save, an `expect` on the facts listed above.
  - It writes to `/work/.t3/worktrees/shadowgit-mcp-server/review-comments/tests/fixtures/…`.
- [ ] **Step 2: Run** it in the app worktree with `E2E_SCRATCH=1 E2E_ARTIFACTS_DIR=/work/artifacts npm run test:e2e -- scratch/capture-comment-answers`. Expected: PASS, and the seven files are written. Then check that nothing is left running: `pgrep -af "1280x800x24|playwright test -c e2e|electron/dist/electron"`.
- [ ] **Step 3: Delete the scratch spec. Commit the fixtures:** `test: real app answers for review comments and the docs range, captured from the app`.

### Task 2: The mirror reads comments, replies, open comments on start, and the docs routes' new fields

**Files:**
- Modify: `src/session-api.ts`, `src/doc-shapes.ts`, `tests/helpers/fake-app.ts`
- Create: `src/comment-shapes.ts`
- Test: `tests/session-api.test.ts`

**Interfaces:**
- Produces, in `src/comment-shapes.ts`:
  - `CommentLines = z.object({ side: z.string(), start: int, end: int })`, where `side` is an open string (`head` or `base` today);
  - `ReviewComment = z.object({ id, tag: z.string(), body, anchor: { snapshot, path, lines: CommentLines.nullable(), quote: z.array(z.string()), symbol: z.string().nullable() }, since: z.object({ snapshot }).nullable(), replies: z.array(CommentReply) })`. `tag` is an open string (`change`, `question` or `note` today);
  - `CommentReply = z.object({ by, text, at, snapshot: z.string().nullable() })`;
  - `ReviewSend = z.object({ id, at, range: z.object({ label, base: nullable, head }).nullable(), unviewed: z.array(z.string()).nullable(), moreUnviewed: int, comments: z.array(ReviewComment) })`;
  - `CommentsRead = z.object({ sends: z.array(ReviewSend) })`.
- Produces, in `src/session-api.ts`:
  - `export const APP_WITHOUT_COMMENTS`: the verbatim message.
  - `readComments(repoPath: string): Promise<z.infer<typeof CommentsRead>>`.
  - `replyToComment(input: { repoPath: string; id: number; text: string; author: string }): Promise<z.infer<typeof CommentReply>>`.
  - `startSession` returns `{ sessionId: string; openComments: number }`, with 0 when the app sends none.
  - `readDocs` takes `base?: string | null` and `head?: string`. With `head`, it sets `base` (`''` for null) and `head`, as `readLens` does.
- Produces, in `src/doc-shapes.ts`: `DocsWritten` gains `left: z.array(z.object({ page: DocKey.nullable(), why: z.string() })).optional()`.
- `read()`'s `what` union gains `'review comment'`.
- Produces, in the fake app:
  - `commentRoutes: boolean`, true by default, with `false` playing an app before 0.4.0 that answers `Not found`;
  - `commentsAnswer: object`, `{ sends: [] }` by default;
  - `COMMENT_ANSWERS` with the five fixtures, without `success`.
  - `POST /comments/reply` appends `{ by: body.author, text, at, snapshot: null }` to the matching comment in `commentsAnswer`, and answers it. A missing id answers `no-comment.json`'s 404.
  - `/session/start` adds `openComments` when `commentsAnswer` holds any comment.
  - The catch-all 404 answers `{ success: false, error: 'Not found' }`, as the app does.

- [ ] **Step 1: Write the failing tests** in `tests/session-api.test.ts`:
  - `'reads the open comments by Send, as the app answers them'`: parse `open.json` and `answered.json` through `readComments`, comparing against the fixture's sends, field by field, for the fields kept.
  - `'stores a reply with the agent as author, and passes on the app's reason for a comment that is not open'`:
    - the request body is `{ repoPath, id: 2, text, author: 'Claude Code' }`;
    - id 99 rejects with `ShadowGit: There is no open comment #99`.
  - `'asks for an app update when the comment routes are missing, and only then'`:
    - with `commentRoutes = false`, both reject with `APP_WITHOUT_COMMENTS`;
    - the reply route's own 404 does not.
  - `'answers the open comments a session starts with, and none from an older app'`: `openComments` is 4 with the comments, and 0 with `commentsAnswer = { sends: [] }`.
  - `'asks the docs route for a range, from the start of the history with an empty base'`: the request query has `base=` and `head=<hash>`.
  - `'reads the pages a write left out, and none from an older app'`: `written-left.json`'s `left` is read, and an answer without `left` parses.
- [ ] **Step 2: Run** `npx vitest run tests/session-api.test.ts`. Expected: FAIL. `readComments`, `replyToComment` and `APP_WITHOUT_COMMENTS` are not exported, and `left` and `openComments` are dropped.
- [ ] **Step 3: Implement** the Interfaces above.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, every earlier test included.
- [ ] **Step 5: Commit** `feat: read review comments, reply, and the docs routes' range and left`.

### Task 3: `get_review_comments`, `reply_to_review_comment`, `start_session`'s sentence, the instructions

**Files:**
- Create: `src/tools/comments.ts`
- Modify: `src/server.ts` (register after `registerDocs`; the instruction line), `src/tools/start-session.ts`
- Test: create `tests/tools-comments.test.ts`; modify `tests/tools-write.test.ts`, `tests/e2e.test.ts` and `tests/__snapshots__/tool-list.json`

**Interfaces:**
- Consumes: Task 2's `readComments`, `replyToComment`, `startSession` and `CommentsRead`.
- Produces:
  - `getReviewComments({ repo }: { repo?: string }): Promise<CallToolResult>`;
  - `replyToReviewComment({ id, text, repo }: { id: number; text: string; repo?: string }, author: string): Promise<CallToolResult>`;
  - `registerComments(server)`.
- **`get_review_comments` description**, verbatim:

  > Read the review comments the person sent you from ShadowGit for a tracked project: the sent ones they have not resolved, grouped by the Send that carried them, oldest first. Each comment has its id, its tag (change, question or note: the person's own), its words and where it is. That is the snapshot it was written on, the file, the lines (on the new side, or removed ones, or none for the whole file), the lines quoted as they read then, and the definition around them. It also has since, the snapshot that changed its quoted lines after it was written (null when none did), and the replies so far. Each Send has the range the person had open and the files of that range they had not viewed (unviewed, then moreUnviewed), so a file they did not read is not one they approved. Change only what each comment asks, at its lines: a question is answered in your reply, and a note changes nothing unless its words ask for a change. Ask the person before you change anything else. Once a comment is done, reply to it with reply_to_review_comment: what you changed, or your answer. Only the person resolves a comment, in ShadowGit. Needs the ShadowGit app running.

  Annotations: read-only, idempotent.
- **`reply_to_review_comment` description**, verbatim:

  > Reply to one review comment the person sent from ShadowGit, by its id from get_review_comments: what you changed for it, or your answer to its question, in a sentence or two. ShadowGit shows the reply under the comment with your name and the snapshot that holds your change; during a session, that is the snapshot its checkpoint or its end makes. A reply leaves the comment open: only the person resolves it. Needs the ShadowGit app running.

  - Input `id`: `z.number().int().positive().describe("The comment's id, as get_review_comments gives it")`.
  - Input `text`: `z.string().trim().min(1).max(1_000).describe('What you changed for it, or your answer: at most 1,000 characters')`.
  - Input `repo`: `repoParam`.
  - Annotations: not read-only, not destructive, not idempotent.
  - Text: "Your reply is under comment #2 in ShadowGit, at snapshot 1a2b3c4d." When `snapshot` is null: "Your reply is under comment #1 in ShadowGit; it names the snapshot of this session's checkpoint or end."

- [ ] **Step 1: Write the failing tests:**
  - `tests/tools-comments.test.ts`:
    - `'reads the open comments of the current project, by Send, with the step to reply to each'`:
      - structured `sends` equal the fixture's, minus the left-out fields;
      - `next` is "Change only what each comment asks, then reply to each with reply_to_review_comment: #1, #2, #3 and #4.";
      - the text holds `#1 [Change] src/api/cart.ts:11 (shipping)` and `   > ` before the quoted line.
    - `'reads a comment on a whole file, on removed lines, a since and a reply waiting for its snapshot as the app's card does'`:
      - with `answered.json` and a comment varied to `lines: null` and another to `side: 'base'`, the text holds `src/api/orders.ts` with no `:` line, `(removed lines)`, `Lines changed since, in <short>.`, `Claude Code, session in progress: Raised the threshold to 100.`, and `Claude Code at <short>: It rounds`.
    - `'lists the files the person had not viewed, and how many more'`: the text holds Send 1's ledger line from `open.json`.
    - `'says when there is no open comment, with no step to take'`: `sends: []` gives no `next`, and the text "No open review comments on webshop: the person has sent none, or resolved them all."
    - `'names another project in its step, and replies there'`: with `repo` set, `next` starts with `For <repo>, pass repo "<repo>"`, and the reply request's `repoPath` is that project's.
    - `'replies as the client, and says which snapshot the reply names'`: both texts as above.
    - `'refuses a blank reply or one past 1,000 characters before asking the app'`: through the listed input schema, with no request sent.
    - `'asks for an app update when the routes are missing'`.
  - `tests/tools-write.test.ts`:
    - `'names the open review comments as a session starts, without asking to act on them'`: `review` is the verbatim sentence for 4, singular for 1, and absent for 0.
  - `tests/e2e.test.ts`:
    - the tool list pins thirteen names, with `get_review_comments` and `reply_to_review_comment` after `write_docs`; update the file snapshot with `npx vitest run -u tests/e2e.test.ts` once the names are right;
    - `INSTRUCTIONS` contains the line from Call 5;
    - both descriptions and their input schemas are checked against `JUDGING`;
    - `get_review_comments`' description contains "Change only what each comment asks" and "Only the person resolves a comment".
- [ ] **Step 2: Run** `npx vitest run tests/tools-comments.test.ts tests/tools-write.test.ts tests/e2e.test.ts`. Expected: FAIL. The module is missing, there is no `review`, and the tool list has eleven names.
- [ ] **Step 3: Implement** the Interfaces. `placeOf` mirrors the app's `review-text.ts`, with each Send's header and ledger; `andList` and `forProject` come from `shared.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: get_review_comments and reply_to_review_comment; start_session names the open comments`.

### Task 4: Follow-up 2: the docs step reads the range's pages; `write_docs` leaves the checking to the app

**Files:**
- Modify: `src/tools/lens.ts` (`sessionPages` → `rangePages`, `docsStep`, `isRange` removed if unused), `src/tools/docs.ts`
- Test: `tests/tools-lens.test.ts`, `tests/tools-docs.test.ts`, `tests/__snapshots__/write-docs.txt` and `tool-list.json` where they change

**Interfaces:**
- Consumes: Task 2's `readDocs({ base, head })` and `DocsWritten.left`.
- Produces:
  - `get_docs` input gains `base: Snapshot.nullable().optional().describe('With head: the pages this range changed, as get_lens names a range; null from the start of the history')` and `head: Snapshot.optional().describe('With base: the end of the range')`;
  - its description's "With no arguments" sentence gains: "With base and head: the pages that range changed whose words are missing or behind."
  - Refusals before any request, verbatim:
    - "Pass base and head together." when only one of them is passed;
    - "Ask for a range, name areas, or ask for all: one of them." when either is mixed with `areas`, `overview`, `all` or `more`.
  - The docs step reads, verbatim except for the names: "…The session's last step: the docs pages of the areas it changed, src/billing and src/jobs, need words, so the pages the user reads in ShadowGit describe the code as it is now. A page with no words can start short, from its facts and the code you read. get_docs with base "<base or null>" and head "<head>", then write_docs."

- [ ] **Step 1: Write the failing tests:**
  - `tests/tools-lens.test.ts`:
    - replace `"asks for the latest AI session's pages only when the words are for its range"` with `'asks for the pages of the range the words are for, without reading the Lens first'`:
      - for a range other than `lensAnswer`'s, the step names `range.json`'s pages and `get_docs with base`;
      - no `/lens?` request follows `/lens/words`;
      - the `/docs?` request has that `base` and `head`.
    - keep `'answers as before when the app has no docs…'` green.
  - `tests/tools-docs.test.ts`:
    - `'asks for the pages of a range'`: the query has `base` and `head`, with no `area` and no `all`;
    - `'refuses half a range, or a range with areas or all, before asking the app'`;
    - replace `"leaves out a page past the app's rules for words, with why, and sends the others"` with `'sends every page, and names the pages the app left out, with why'`:
      - a 201-character summary is sent;
      - with `docsWritten` = `written-left.json`, the text's "Left out:" holds `src/jobs`, and the structured `left` holds its `why`;
    - replace `'sends nothing when every page is left out'` with `"passes on the app's reason when it keeps no page"`: a 400 `No page to keep: …` from a fake `answers` override rejects with `ShadowGit: No page to keep`.
- [ ] **Step 2: Run** `npx vitest run tests/tools-lens.test.ts tests/tools-docs.test.ts`. Expected: FAIL. The step still probes the Lens, `get_docs` has no range, and `write_docs` still checks pages itself.
- [ ] **Step 3: Implement** the Interfaces:
  - delete `AppWords`, `bodyWords` and `Left`;
  - `appPage` returns `AppDocWrite` or throws;
  - `writeDocs` sends every page.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(docs): the docs step and get_docs read a range's pages; the app checks each page's words`.

### Task 5: `eval:comments`, the phrase, the README, and 2.7.0

**Files:**
- Create: `scripts/eval-comments.ts`
- Modify: `package.json` (`"eval:comments": "npm run build && tsx scripts/eval-comments.ts"`, version), `package-lock.json`, `server.json`, `scripts/eval-docs-phrases.ts`, `README.md`, `CHANGELOG.md`
- Test: `tests/release.test.ts` (existing), the evals run by hand

**Interfaces:**
- Consumes:
  - `runClaude`, `STREAM_ARGS`, `readStream`, `EDITS` and `ago` from `scripts/claude.ts`;
  - `COMMENT_ANSWERS.open`, `MAP_PROJECT` and `startFakeApp` from the fake app;
  - `makeProject` and `removeTempDirs` from the fixtures.

- [ ] **Step 1: Write `scripts/eval-comments.ts`.**
  - The header comment says what it measures, its pass rule and the bar, in the style of `eval-rules.ts`.
  - **Self-check first:**
    - `onlyInside(project, file, span)` is true on the untouched project;
    - it is false after an edit to line 1 of `src/api/cart.ts`;
    - it is true after an edit of line 11 alone.
  - **Each run:**
    - `makeProject('webshop', MAP_PROJECT, ago(60))`;
    - `app.commentsAnswer` is a deep copy of `COMMENT_ANSWERS.open`;
    - the prompt, verbatim: "Address my ShadowGit review comments.";
    - `timeoutMs: 420_000`.
  - **The pass rule** is Call 8's. Each run logs:
    - `PASS`/`FAIL` and the reasons it failed;
    - the tools in order, the replies by id, and its cost.
  - **The end:**
    - prints "N of 10 runs addressed the comments as asked (pass at 8)";
    - `process.exitCode` is 0 at or over the bar;
    - errored runs are counted as neither, as `eval-rules.ts` does.
- [ ] **Step 2: Add the phrase** "Address my ShadowGit review comments" to `scripts/eval-docs-phrases.ts`:
  - `prepare`: snapshot `MAP_PROJECT` and set `app.commentsAnswer`;
  - `passed`: a `/comments?` request was made.

  Add the same phrase to the README's "What to ask".
- [ ] **Step 3: Run** `npm run typecheck && npm run lint`. Expected: clean.
- [ ] **Step 4: Run the evals** through `claude-personal3`, with a `claude` shim placed first on `PATH` that runs `exec claude-personal3 "$@"`, in `/work/artifacts/mcp-review-comments-2026-11-02/`:
  - `npm run eval:comments`. Expected: at least 8 of 10.
  - `npm run eval`. Expected: every phrase passes.

  A run under the bar is a finding: read the transcripts (tools in order, the replies) and fix the descriptions or the instruction line, never the pass rule. Then run again, up to three rounds. Save each run's log in the artifacts folder.
- [ ] **Step 5: Release files:**
  - version 2.7.0 in `package.json`, `package-lock.json` (both places) and `server.json`;
  - CHANGELOG `## [2.7.0] - <date>`:
    - Added: the two tools and start_session's sentence;
    - Changed: the docs step for any range, `get_docs`' range, `write_docs` leaving the checking to the app;
    - the eval figures;
    - "Needs ShadowGit 0.4.0";
  - README: the tools table gains both tools.
  - Keep CRLF.
  - Run `npm test`. Expected: PASS, `release.test.ts` included.
- [ ] **Step 6: Commit** `feat: eval:comments, and 2.7.0` and `chore: 2.7.0` (two commits: the eval with its phrase, then the release files).
