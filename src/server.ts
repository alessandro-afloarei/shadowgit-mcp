import { McpServer } from '@modelcontextprotocol/server';
import { registerCheckpoint } from './tools/checkpoint.js';
import { registerComments } from './tools/comments.js';
import { registerDocs } from './tools/docs.js';
import { registerEndSession } from './tools/end-session.js';
import { registerFacts } from './tools/facts.js';
import { registerGitCommand } from './tools/git-command.js';
import { registerLens } from './tools/lens.js';
import { registerListRepos } from './tools/list-repos.js';
import { registerMap } from './tools/map.js';
import { registerStartSession } from './tools/start-session.js';
import { VERSION } from './version.js';

export const INSTRUCTIONS = [
  "ShadowGit snapshots each tracked project every few minutes into a separate history (.shadowgit.git), so it holds changes the project's git never saw.",
  "Before your first edit in a tracked project, call get_code_context for the files or symbols you will change: it lists what depends on them across the project by area, callers grep misses included (top-level code, imports through re-exports), where the change lands, and the project's rules for them, from its .shadowgit-rules file, which say only what must not depend on what: add no link they name. get_map shows how the project is organised.",
  'Task → tool:',
  "- What changed recently, a file's history, when something broke, what the user was doing at a given time: git_command with read-only git (log --since, diff, show, blame).",
  "- Before editing several files in a tracked project: start_session, which pauses snapshots. When a session's edits are done, whoever started it: `checkpoint` with a specific title, end_session, then get_lens and write_lens_words (a summary, a title and a sentence for each step, a role for each changed card), so the user reads your change in ShadowGit's Lens in your words. The docs pages it then names are part of the session: get_docs, write_docs.",
  '- What a part of the project does, or documenting it: get_docs, then write_docs.',
  '- Any edit, even one line, in a project with rules (get_code_context lists them) or to .shadowgit-rules: start_session first, so `checkpoint` checks the change against them.',
  '- The user asks to save their work or a snapshot: `checkpoint`.',
  "- A project name you don't recognise: list_repos.",
  "Every tool defaults to the project you are working in; pass repo only for another project. Older snapshot titles may give UTC times; git's dates are right.",
].join('\n');

// Claude Code cuts a server's instructions at 4,096 characters: the project's outline after them keeps within 4,000
export const OUTLINE_BUDGET = 4_000 - INSTRUCTIONS.length - 1;

/** The server, its instructions ending with the project's outline when there is one. */
export function buildServer(outline: string | null): McpServer {
  const server = new McpServer(
    { name: 'shadowgit', title: 'ShadowGit', version: VERSION, websiteUrl: 'https://shadowgit.com' },
    { instructions: outline === null ? INSTRUCTIONS : `${INSTRUCTIONS}\n${outline}` },
  );
  registerListRepos(server);
  registerGitCommand(server);
  registerMap(server);
  registerStartSession(server);
  registerCheckpoint(server);
  registerEndSession(server);
  registerLens(server);
  registerDocs(server);
  registerComments(server);
  registerFacts(server);
  return server;
}
