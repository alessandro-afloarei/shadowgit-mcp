import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { APP_WITHOUT_COMMENTS } from '../src/session-api.js';
import { getReviewComments, replyToReviewComment } from '../src/tools/comments.js';
import { COMMENT_ANSWERS, startFakeApp, type CommentsWire, type FakeApp } from './helpers/fake-app.js';
import { JUDGING, makeProject, removeTempDirs, restoreEnv, textOf, useStorage } from './helpers/fixtures.js';

let project: string;
let other: string;
let app: FakeApp;

beforeAll(async () => {
  project = makeProject('webshop');
  other = makeProject('blog');
  useStorage([{ name: 'webshop', path: project }, { name: 'blog', path: other }]);
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
  app.commentRoutes = true;
  app.commentsAnswer = COMMENT_ANSWERS.open;
  app.answers = {};
});

const sends = (answer: CommentsWire) => answer.sends.map(({ id, at, range, unviewed, moreUnviewed, comments }) => ({
  id, at, range, unviewed, moreUnviewed, comments: comments.map(({ id: comment, tag, body, anchor, since, replies }) => ({ id: comment, tag, body, anchor, since, replies })),
}));

/** A comment of an answer, varied: its anchor's lines, or its side. */
const varied = (answer: CommentsWire, id: number, anchor: (lines: { side: string; start: number; end: number }) => object) => ({
  sends: answer.sends.map((send) => ({
    ...send,
    comments: send.comments.map((comment) => {
      if (comment.id !== id) return comment;
      const old = comment.anchor as { lines: { side: string; start: number; end: number } };
      return { ...comment, anchor: { ...old, ...anchor(old.lines) } };
    }),
  })),
});

const short = (hash: unknown) => String(hash).slice(0, 8);

describe('get_review_comments', () => {
  it('reads the open comments of the current project, by Send, with the step to reply to each', async () => {
    const result = await getReviewComments({});
    expect(app.requests.map((request) => request.path)).toEqual([`/comments?${new URLSearchParams({ repoPath: project })}`]);
    expect(result.structuredContent).toEqual({
      repo: 'webshop',
      sends: sends(COMMENT_ANSWERS.open),
      next: 'Change only what each comment asks, then reply to each with reply_to_review_comment: #1, #2, #3 and #4.',
    });
    const text = textOf(result);
    const head = short((COMMENT_ANSWERS.open.sends[0]?.range as { head: string }).head);
    expect(text.split('\n')[0]).toBe('4 open review comments on webshop, in 2 Sends.');
    expect(text).toContain(`#1 [Change] src/api/cart.ts:11 (shipping) · at ${head}\n   >   return total > 50 ? 0 : 5;\n   Free shipping starts at 100, not 50.`);
    expect(text).toContain(`#4 [Note] src/jobs/cleanup.ts:11-13 (purgeLogs) · at ${head}`);
    expect(text).toContain('Send 2, with no range open:');
    expect(text.split('\n').at(-1)).toBe('Next: Change only what each comment asks, then reply to each with reply_to_review_comment: #1, #2, #3 and #4.');
    expect(text).not.toMatch(JUDGING);
  });

  it("reads a comment on a whole file, on removed lines, a since and a reply waiting for its snapshot as the app's card does", async () => {
    const replied = COMMENT_ANSWERS.answered.sends.flatMap((send) => send.comments);
    const since = (replied.find((comment) => comment.id === 3)?.since as { snapshot: string }).snapshot;
    const stamped = (replied.find((comment) => comment.id === 2)?.replies[0] as { snapshot: string }).snapshot;
    app.commentsAnswer = varied(varied(COMMENT_ANSWERS.answered, 3, () => ({ lines: null })), 4, (lines) => ({ lines: { ...lines, side: 'base' } }));
    const text = textOf(await getReviewComments({}));
    expect(text).toContain('#3 [Change] src/api/orders.ts · at');
    expect(text).toContain(`   Lines changed since, in ${short(since)}.`);
    expect(text).toContain('#4 [Note] src/jobs/cleanup.ts:11-13 (removed lines) · at');
    expect(text).toContain('   Claude Code, session in progress: Raised the threshold to 100.');
    expect(text).toContain(`   Claude Code at ${short(stamped)}: It rounds a fractional discount to whole cents.`);
  });

  it('lists the files the person had not viewed, and how many more', async () => {
    const [first] = COMMENT_ANSWERS.open.sends;
    const unviewed = first?.unviewed as string[];
    const text = textOf(await getReviewComments({}));
    expect(text).toContain(`Files the person had not viewed: ${unviewed.join(', ')} …and ${String(first?.moreUnviewed)} more`);
    expect(text).toContain(`Send 1, reading This AI session (${short((first?.range as { base: string }).base)}..`);
  });

  it('says when there is no open comment, with no step to take', async () => {
    app.commentsAnswer = { sends: [] };
    const result = await getReviewComments({});
    expect(result.structuredContent).toEqual({ repo: 'webshop', sends: [] });
    expect(textOf(result)).toBe('No open review comments on webshop: the person has sent none, or resolved them all.');
  });

  it('names another project in its step, and replies there', async () => {
    const result = await getReviewComments({ repo: 'blog' });
    expect(app.requests[0]?.path).toBe(`/comments?${new URLSearchParams({ repoPath: other })}`);
    expect(result.structuredContent).toMatchObject({ repo: 'blog', next: expect.stringMatching(/^For blog, pass repo "blog" to each tool\. Change only what each comment asks/) });
    await replyToReviewComment({ id: 2, text: 'Answered.', repo: 'blog' }, 'Claude Code');
    expect(app.requestsTo('/comments/reply')).toEqual([{ repoPath: other, id: 2, text: 'Answered.', author: 'Claude Code' }]);
  });

  it('asks for an app update when the routes are missing', async () => {
    app.commentRoutes = false;
    await expect(getReviewComments({})).rejects.toThrow(APP_WITHOUT_COMMENTS);
    await expect(replyToReviewComment({ id: 2, text: 'Answered.' }, 'Claude Code')).rejects.toThrow(APP_WITHOUT_COMMENTS);
  });
});

describe('reply_to_review_comment', () => {
  it('replies as the client, and says which snapshot the reply names', async () => {
    const waiting = await replyToReviewComment({ id: 1, text: 'Raised the threshold to 100.' }, 'Claude Code');
    expect(app.requestsTo('/comments/reply')).toEqual([{ repoPath: project, id: 1, text: 'Raised the threshold to 100.', author: 'Claude Code' }]);
    expect(waiting.structuredContent).toEqual({ repo: 'webshop', id: 1, reply: { by: 'Claude Code', text: 'Raised the threshold to 100.', at: expect.any(String), snapshot: null } });
    expect(textOf(waiting)).toBe("Your reply is under comment #1 in ShadowGit; it names the snapshot of this session's checkpoint or end.");

    app.answers['/comments/reply'] = COMMENT_ANSWERS.reply;
    const stamped = await replyToReviewComment({ id: 2, text: 'It rounds a fractional discount to whole cents.' }, 'Claude Code');
    expect(textOf(stamped)).toBe(`Your reply is under comment #2 in ShadowGit, at snapshot ${short(COMMENT_ANSWERS.reply.reply.snapshot)}.`);
  });

  it("passes on the app's reason for a comment that is not open", async () => {
    await expect(replyToReviewComment({ id: 99, text: 'Done.' }, 'Claude Code')).rejects.toThrow('ShadowGit: There is no open comment #99: it was never sent, or is resolved');
  });
});
