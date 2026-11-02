import * as z from 'zod/v4';

/**
 * The person's review comments as GET /api/comments answers them (the app's CommentView and SendRecord), each without
 * the fields an agent has no use for: its record's version, status, send and times. Open values are strings: a newer
 * app may add to them.
 */

/** Lines of a file on one side: the new ones (head) or the removed ones (base). */
const CommentLines = z.object({ side: z.string().describe('head (new lines) or base (removed lines)'), start: z.number().int(), end: z.number().int() });

/** An agent's reply: who, what, when, and the snapshot that holds its work, null while its session is still open. */
export const CommentReply = z.object({ by: z.string(), text: z.string(), at: z.string(), snapshot: z.string().nullable() });

const ReviewComment = z.object({
  id: z.number().int(),
  tag: z.string().describe("change, question or note: the person's own"),
  body: z.string(),
  anchor: z.object({
    snapshot: z.string().describe('The snapshot it was written on'),
    path: z.string(),
    lines: CommentLines.nullable().describe('Null for the whole file'),
    quote: z.array(z.string()).describe('The lines as they read then'),
    symbol: z.string().nullable().describe('The definition around them'),
  }),
  since: z.object({ snapshot: z.string() }).nullable().describe('The snapshot that changed its quoted lines after it was written'),
  replies: z.array(CommentReply),
});

const ReviewSend = z.object({
  id: z.number().int(),
  at: z.string(),
  range: z.object({ label: z.string(), base: z.string().nullable(), head: z.string() }).nullable().describe('The range open in Changes at the Send; null when none was'),
  unviewed: z.array(z.string()).nullable().describe('Files of that range the person had not viewed then, at most 20'),
  moreUnviewed: z.number().int(),
  comments: z.array(ReviewComment),
});

export const CommentsRead = z.object({ sends: z.array(ReviewSend) });

export type ReviewCommentRead = z.infer<typeof ReviewComment>;
export type ReviewSendRead = z.infer<typeof ReviewSend>;
