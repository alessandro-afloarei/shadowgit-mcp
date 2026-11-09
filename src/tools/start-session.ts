import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { asClient } from '../client-name.js';
import { resolveRepo } from '../repos.js';
import { activeSessions, startSession as startAppSession } from '../session-api.js';
import { dataResult, forProject, plural, repoParam } from './shared.js';

const Output = z.object({
  session_id: z.string(),
  repo: z.string(),
  already_active: z.boolean(),
  review: z.string().optional().describe('When the person has sent review comments still open: how many, and when to read them'),
});

/** The person's open review comments, named as a session starts: read when they ask, so an old one never steers a new task. */
const reviewOf = (count: number) =>
  `The person sent ${plural(count, 'review comment')} on this project. Read ${count === 1 ? 'it' : 'them'} with get_review_comments when they ask you to address their review.`;

export async function startSession({ description, repo }: { description: string; repo?: string }, client: string): Promise<CallToolResult> {
  const project = resolveRepo(repo);
  const existing = (await activeSessions()).find((s) => s.repoPath === project.path);
  if (existing) {
    return dataResult(
      Output,
      `A session is already active on ${project.name}: ${existing.id} ("${existing.description}"). Automatic snapshots stay paused until it ends.`,
      { session_id: existing.id, repo: project.name, already_active: true },
    );
  }
  const { sessionId: id, openComments } = await startAppSession(project.path, description, client);
  // Another project's sentence names it: get_review_comments without repo would read the current one
  const review = openComments > 0 ? `${forProject(repo, project)}${reviewOf(openComments)}` : undefined;
  return dataResult(
    Output,
    [`Started session ${id} on ${project.name}. Automatic snapshots are paused until end_session.`, ...(review === undefined ? [] : [review])].join(' '),
    { session_id: id, repo: project.name, already_active: false, ...(review !== undefined && { review }) },
  );
}

export function registerStartSession(server: McpServer): void {
  server.registerTool(
    'start_session',
    {
      title: 'Start a ShadowGit session',
      description:
        "Pause ShadowGit's automatic snapshots for a project while you make a set of related edits, so they can be saved as one snapshot with a title instead of several partial ones. A session is what the person then reviews in ShadowGit: start one when they ask you to start a ShadowGit session. Returns the existing session if one is already active. Needs the ShadowGit app running. To save the edits and resume snapshots, use `checkpoint` and end_session.",
      inputSchema: z.object({
        description: z.string().min(1).max(200).describe('What you are about to change, e.g. "Fix login redirect"'),
        repo: repoParam,
      }),
      outputSchema: Output,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    asClient(server, startSession),
  );
}
