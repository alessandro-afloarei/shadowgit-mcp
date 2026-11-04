import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * One word per idea in every sentence the assistant reads from this server, and so says to the person: project (never
 * repository), snapshot (never commit), saved snapshot (never checkpoint), a change or a session (never range), you or
 * your assistant (never agent or AI session). The words are ShadowGit's simplify design
 * (shadowgit-app docs/superpowers/specs/2026-11-03-simplify-and-guide-design.md). Code spans are not sentences, so the
 * tool `checkpoint` is named in backticks.
 */
const OLD_WORDS = /\b(repositor\w*|commits?|agents?|ranges?|checkpoints?|AI sessions?)\b/i;

type Sentence = { line: number; text: string };

/** The sentences of a source: each string literal or template holding a space, a template's pieces joined with "…". */
function sentencesIn(source: string): Sentence[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const found: Sentence[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('…') : node.text;
      if (/\s/.test(text)) found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The README's lines outside fenced code. */
function proseLines(markdown: string): Sentence[] {
  let fenced = false;
  return markdown.split('\n').flatMap((text, index) => {
    if (text.trimStart().startsWith('```')) fenced = !fenced;
    return fenced || text.trimStart().startsWith('```') ? [] : [{ line: index + 1, text }];
  });
}

const oldWordsIn = (file: string, sentences: Sentence[]) =>
  sentences.filter(({ text }) => OLD_WORDS.test(text.replace(/`[^`]*`/g, ''))).map(({ line, text }) => `${file}:${line}: ${text}`);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : file.endsWith('.ts') ? [file] : [];
  });

describe('the words', () => {
  it('reads sentences, never code spans', () => {
    const sample = [
      "const named = 'Save it with `checkpoint`.';",
      "const arg = 'log';",
      'const saved = `Saved checkpoint ${hash} on ${name}`;',
      "const session = 'the latest AI session';",
    ].join('\n');
    expect(oldWordsIn('sample.ts', sentencesIn(sample))).toEqual(['sample.ts:3: Saved checkpoint … on …', 'sample.ts:4: the latest AI session']);
    expect(oldWordsIn('README.md', proseLines('Save a snapshot.\n```\ngit commit\n```\nA checkpoint.'))).toEqual(['README.md:5: A checkpoint.']);
  });

  it("says every sentence in the person's words", () => {
    const hits = [
      ...sourceFiles('src').flatMap((file) => oldWordsIn(file, sentencesIn(readFileSync(file, 'utf8')))),
      ...oldWordsIn('README.md', proseLines(readFileSync('README.md', 'utf8'))),
    ];
    expect(hits).toEqual([]);
  });
});
