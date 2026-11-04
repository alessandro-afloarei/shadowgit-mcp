import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { asClient } from '../client-name.js';
import { CommentReply, CommentsRead } from '../comment-shapes.js';
import { resolveRepo } from '../repos.js';
import { readComments, replyToComment } from '../session-api.js';
import { snapshots } from './rules.js';
import { andList, dataResult, forProject, list, plural, repoParam } from './shared.js';

const CommentsOutput = z.object({
  repo: z.string(),
  ...CommentsRead.shape,
  next: z.string().optional().describe('The step that follows: change what each comment asks, then reply to each'),
});
const ReplyOutput = z.object({ repo: z.string(), id: z.number().int(), reply: CommentReply });

type Send = z.infer<typeof CommentsRead>['sends'][number];
type Comment = Send['comments'][number];

// The app's COMMENT_LIMITS.reply
const REPLY_MAX = 1_000;

const short = (hash: string) => hash.slice(0, 8);

/** Where a comment is, as the app's clipboard text says it: the file alone, or its lines (removed ones said so) and the definition around them. */
function placeOf({ anchor }: Comment): string {
  if (anchor.lines === null) return anchor.path;
  const { side, start, end } = anchor.lines;
  const at = `${anchor.path}:${start === end ? start : `${start}-${end}`}`;
  if (side === 'base') return `${at} (removed lines)`;
  return anchor.symbol === null ? at : `${at} (${anchor.symbol})`;
}

/** A comment as the app's card reads it: its tag, place and snapshot, the lines quoted, its words, what changed since and the replies. */
function commentLines(comment: Comment): string[] {
  const tag = `${comment.tag.charAt(0).toUpperCase()}${comment.tag.slice(1)}`;
  return [
    `#${comment.id} [${tag}] ${placeOf(comment)} · at ${short(comment.anchor.snapshot)}`,
    ...comment.anchor.quote.map((line) => `   > ${line}`),
    ...comment.body.split('\n').map((line) => `   ${line}`),
    ...(comment.since === null ? [] : [`   Lines changed since, in ${short(comment.since.snapshot)}.`]),
    ...comment.replies.map(({ by, snapshot, text }) => `   ${snapshot === null ? `${by}, session in progress` : `${by} at ${short(snapshot)}`}: ${text}`),
  ];
}

function sendLines(send: Send): string[] {
  const range = send.range === null ? 'with no change open' : `reading ${send.range.label} (${snapshots(send.range)})`;
  const unviewed = send.unviewed ?? [];
  return [
    `Send ${send.id}, ${range}:`,
    ...send.comments.flatMap(commentLines),
    ...(unviewed.length === 0 ? [] : [`Files the person had not viewed: ${list({ items: unviewed, total: unviewed.length + send.moreUnviewed }, (file) => file)}`]),
  ];
}

export async function getReviewComments({ repo }: { repo?: string }): Promise<CallToolResult> {
  const project = resolveRepo(repo);
  const { sends } = await readComments(project.path);
  const ids = sends.flatMap((send) => send.comments.map((comment) => comment.id)).sort((a, b) => a - b);
  if (ids.length === 0) {
    return dataResult(CommentsOutput, `No open review comments on ${project.name}: the person has sent none, or resolved them all.`, { repo: project.name, sends });
  }
  const next = `${forProject(repo, project)}Change only what each comment asks, then reply to each with reply_to_review_comment: ${andList(ids.map((id) => `#${id}`))}.`;
  const text = [
    `${plural(ids.length, 'open review comment')} on ${project.name}, in ${plural(sends.length, 'Send')}.`,
    ...sends.flatMap((send) => ['', ...sendLines(send)]),
    '',
    `Next: ${next}`,
  ].join('\n');
  return dataResult(CommentsOutput, text, { repo: project.name, sends, next });
}

export async function replyToReviewComment({ id, text, repo }: { id: number; text: string; repo?: string }, author: string): Promise<CallToolResult> {
  const project = resolveRepo(repo);
  const reply = await replyToComment({ repoPath: project.path, id, text, author });
  const where = reply.snapshot === null ? "; it names the snapshot this session saves next or ends at." : `, at snapshot ${short(reply.snapshot)}.`;
  return dataResult(ReplyOutput, `Your reply is under comment #${id} in ShadowGit${where}`, { repo: project.name, id, reply });
}

export function registerComments(server: McpServer): void {
  server.registerTool(
    'get_review_comments',
    {
      title: 'Read the review comments',
      description:
        "Read the review comments the person sent you from ShadowGit for a tracked project: the sent ones they have not resolved, grouped by the Send that carried them, oldest first. Each comment has its id, its tag (change, question or note: the person's own), its words and where it is. That is the snapshot it was written on, the file, the lines, numbered as in that snapshot (side head: its new lines; side base: lines it removed, which the file no longer has; null for the whole file), the lines quoted as they read then, and the definition around them. It also has since, the snapshot that changed its quoted lines after it was written (null when none did), and the replies so far. Each Send has the change the person had open and the files of that change they had not viewed (unviewed, then moreUnviewed), so a file they did not read is not one they approved. Change only what each comment asks, at its lines: a question is answered in your reply, and a note changes nothing unless its words ask for a change. Ask the person before you change anything else. Once a comment is done, reply to it with reply_to_review_comment: what you changed, or your answer. Only the person resolves a comment, in ShadowGit. Needs the ShadowGit app running.",
      inputSchema: z.object({ repo: repoParam }),
      outputSchema: CommentsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    asClient(server, getReviewComments),
  );
  server.registerTool(
    'reply_to_review_comment',
    {
      title: 'Reply to a review comment',
      description:
        'Reply to one review comment the person sent from ShadowGit, by its id from get_review_comments: what you changed for it, or your answer to its question, in a sentence or two. ShadowGit shows the reply under the comment with your name and a snapshot: during a session, the one its next saved snapshot or its end makes, which holds your change; outside a session, the newest one as you reply. A reply leaves the comment open: only the person resolves it. Needs the ShadowGit app running.',
      inputSchema: z.object({
        id: z.number().int().positive().describe("The comment's id, as get_review_comments gives it"),
        text: z.string().trim().min(1).max(REPLY_MAX).describe(`What you changed for it, or your answer: at most ${REPLY_MAX.toLocaleString('en-US')} characters`),
        repo: repoParam,
      }),
      outputSchema: ReplyOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    asClient(server, replyToReviewComment),
  );
}
