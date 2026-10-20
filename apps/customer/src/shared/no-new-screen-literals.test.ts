/**
 * A new screen file takes its words from a copy catalogue (`Text`, `t()` or `defineCopy`), never from a sentence typed into the
 * markup, so a language file can reach every word the screen shows (RC-home-ia-05).
 *
 * Like `no-new-hand-schemas.test.ts` this looks only at files this branch ADDS under `apps/customer/src/screens/` against the merge
 * base with `origin/main`, so the files already there are not held to it and the count of typed-in sentences can only go down. A new
 * file that needs a literal says why, on its own line:
 *
 *   // literal-text-ok: the label is a stock-ticker symbol
 *
 * What counts: JSX text with a word in it, a string literal child `{'Words'}`, and the words-bearing attributes below.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url).pathname;
const SCOPE = 'apps/customer/src/screens/';
const WORDS = /\p{L}{2,}/u;
const EXEMPT = /literal-text-ok:[ \t]*\S[^\n]{8,}/;
const ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-placeholder']);

/** The typed-in words a screen file renders outside a catalogue, as `line: text`, or none. */
export function screenLiterals(path: string, text: string): string[] {
  if (!path.startsWith(SCOPE) || !/\.tsx$/.test(path) || /\.test\.tsx$|\.spec\.tsx$|__fixtures__\//.test(path)) return [];
  if (EXEMPT.test(text)) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const note = (node: ts.Node, value: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${line + 1}: ${value.trim().replace(/\s+/g, ' ').slice(0, 60)}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && WORDS.test(node.text)) note(node, node.text);
    else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const expression = node.expression;
      if ((ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) && WORDS.test(expression.text)) {
        note(node, expression.text);
      }
    } else if (ts.isJsxAttribute(node) && ATTRIBUTES.has(node.name.getText(source)) && node.initializer) {
      const value = node.initializer;
      if (ts.isStringLiteral(value) && WORDS.test(value.text)) note(node, value.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Files this branch adds against the merge base: committed, staged or untracked. Renames and moves are not additions. */
function addedFiles(): string[] | null {
  const base = git(['merge-base', 'HEAD', 'origin/main']);
  if (!base) return null;
  const added = git(['diff', '--diff-filter=A', '-M', '--name-only', base, '--', SCOPE]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', SCOPE]);
  if (added === null || untracked === null) return null;
  return [...new Set([...added.split('\n'), ...untracked.split('\n')].filter(Boolean))];
}

describe('new screen files do not type their words into the markup', () => {
  it('holds for every screen file this branch adds', () => {
    const files = addedFiles();
    if (files === null) {
      // No merge base to compare with (a shallow clone, a source archive). Failing here would stop a pull request for a reason that is not in its files.
      console.warn('no-new-screen-literals: no origin/main merge base, check skipped');
      return;
    }
    const problems = files.flatMap((path) => screenLiterals(path, readFileSync(repoRoot + path, 'utf8')).map((hit) => `${path}:${hit}`));
    expect(
      problems,
      'New screens take their words from a copy catalogue (Text, t() or defineCopy). Move the sentence there, or add ' +
        '`// literal-text-ok: <why this is not a sentence>` to the file.',
    ).toEqual([]);
  });

  describe('the rule', () => {
    const file = 'apps/customer/src/screens/x/Room.tsx';
    it('flags a sentence typed into JSX, a string child and a words-bearing attribute, naming the line', () => {
      expect(screenLiterals(file, `export const A = () => <p>Send money now</p>;\n`)).toEqual(['1: Send money now']);
      expect(screenLiterals(file, `export const A = () => <p>{'Send money'}</p>;\n`)).toEqual(['1: Send money']);
      expect(screenLiterals(file, `export const A = () => <input aria-label="Amount to send" />;\n`)).toEqual(['1: Amount to send']);
      expect(screenLiterals(file, `export const A = () => (\n  <div>\n    <Text k="a" />\n    <b>Hello there</b>\n  </div>\n);\n`)).toEqual(
        ['4: Hello there'],
      );
    });
    it('leaves alone copy calls, symbols and punctuation, attributes that carry no words, and a stated exemption', () => {
      expect(screenLiterals(file, `export const A = () => <p>{t('send')} · <Text k="x" /> — 12 / 40</p>;\n`)).toEqual([]);
      expect(screenLiterals(file, `export const A = () => <input lang="en" className="field" aria-label={t('amount')} />;\n`)).toEqual([]);
      expect(
        screenLiterals(file, `// literal-text-ok: stock symbols are not sentences\nexport const A = () => <p>Send money now</p>;\n`),
      ).toEqual([]);
      expect(screenLiterals(file, `// literal-text-ok:\nexport const A = () => <p>Send money now</p>;\n`)).not.toEqual([]);
    });
    it('looks only at screen components, not at tests or other folders', () => {
      expect(screenLiterals('apps/customer/src/screens/x/Room.test.tsx', `const A = () => <p>Send money now</p>;\n`)).toEqual([]);
      expect(screenLiterals('apps/customer/src/features/x/Room.tsx', `const A = () => <p>Send money now</p>;\n`)).toEqual([]);
      expect(screenLiterals('apps/customer/src/screens/x/model.ts', `export const a = 'Send money now';\n`)).toEqual([]);
    });
  });
});
