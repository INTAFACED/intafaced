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
 * What counts: JSX text with a word in it, a line of plain words, a string literal child `{'Words'}` and the words-bearing attributes
 * (`aria-label`, `title`, `placeholder`, `alt` and two aria twins). It reads the text, not the syntax tree, because the compiler's JS API is not a given in CI.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const SCOPE = 'apps/customer/src/screens/';
const EXEMPT = /literal-text-ok:[ \t]*\S[^\n]{8,}/;
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/**
 * Words typed into markup: text between a tag's `>` and the next tag, a line of plain words, a string child, or a words-bearing
 * attribute. Every run is bounded so no input can make the expressions backtrack for long, and the text classes leave out the characters
 * that make code (`( ) ? : & |` and the JSX braces), so a ternary or a condition between two tags is not read as words. The price is a
 * sentence with a colon or a question mark inside it is not caught here.
 */
const INLINE_TEXT = /(?<![=-])>([^<>{}=;()?:&|]{1,400})<(?=\/|[A-Za-z])/gu;
const STRING_CHILD = /(?<=>)\s*\{\s*(['"`])([^'"`\n]{1,300})\1\s*\}/gu;
const ATTRIBUTE =
  /\b(?:aria-label|title|placeholder|alt|aria-description|aria-placeholder)=(?:(["'])([^"'\n]{1,300})\1|\{\s*(["'`])([^"'`$\n]{1,300})\3\s*\})/gu;
/** A line that is only words, as a paragraph broken over lines is; a line that opens with a code keyword is not. */
const TEXT_LINE =
  /^\s*(?!(?:import|export|const|let|var|return|function|type|interface|async|await|else|case|default|break|continue|throw|new|class|extends|if|for|while|switch|try|catch|finally|declare|enum|namespace|as|of|in|void|typeof)\b)\p{L}[\p{L}\p{N}]*(?:[ \t]+[\p{L}\p{N}.,!'’\-–—%]+){1,60}[ \t]*$/u;
const WORD = /\p{L}{2,}/u;

/** The typed-in words a screen file renders outside a catalogue, as `line: text`, or none. */
export function screenLiterals(path: string, text: string): string[] {
  if (!path.startsWith(SCOPE) || !/\.tsx$/.test(path) || /\.test\.tsx$|\.spec\.tsx$|__fixtures__\//.test(path)) return [];
  if (EXEMPT.test(text)) return [];
  const code = stripComments(text);
  const starts = [0];
  for (let at = code.indexOf('\n'); at !== -1; at = code.indexOf('\n', at + 1)) starts.push(at + 1);
  const lineOf = (index: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const found = new Map<number, string>();
  const note = (index: number, value: string) => {
    if (!WORD.test(value)) return;
    const line = lineOf(index);
    if (!found.has(line)) found.set(line, value.trim().replace(/\s+/g, ' ').slice(0, 60));
  };
  for (const match of code.matchAll(INLINE_TEXT)) {
    const words = match[1]!;
    if (WORD.test(words)) note(match.index + 1 + (words.length - words.trimStart().length), words);
  }
  for (const match of code.matchAll(STRING_CHILD)) note(match.index, match[2]!);
  for (const match of code.matchAll(ATTRIBUTE)) note(match.index, match[2] ?? match[4]!);
  code.split('\n').forEach((line, i) => {
    if (line.length <= 400 && TEXT_LINE.test(line)) note(starts[i]!, line);
  });
  return [...found].sort(([a], [b]) => a - b).map(([line, value]) => `${line}: ${value}`);
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
      expect(screenLiterals(file, `export const A = () => <input aria-label={'Amount to send'} />;\n`)).toEqual(['1: Amount to send']);
      expect(screenLiterals(file, `export const A = () => (\n  <p>\n    Send money to a friend\n  </p>\n);\n`)).toEqual([
        '3: Send money to a friend',
      ]);
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
    it('does not mistake ordinary code for words', () => {
      const code = `import { useState } from 'react';\nexport default function Room() {\n  const [n, setN] = useState(0);\n  const more = n > 3 && n < 9;\n  const go = (a: number) => a < n;\n  return (\n    <button type="button" onClick={() => setN(n + 1)} className="field">\n      {t('go')}\n    </button>\n  );\n}\n`;
      expect(screenLiterals(file, code)).toEqual([]);
    });
    it('does not read a ternary chain, a condition or a nullish fallback as words', () => {
      const code = [
        'export const A = () => (',
        '  <div>',
        '    {view ? (',
        '      <p className="a">',
        "        {t('one')}",
        '      </p>',
        '    ) : failed ? (',
        '      <b />',
        '    ) : isLedgerTab(tab) ? (',
        '      <i />',
        '    ) : null}',
        '    {emptyState ??',
        "      t('none')}",
        '    {market && market.strike && market.optionType',
        "      ? t('a')",
        "      : t('b')}",
        '  </div>',
        ');',
        '',
      ].join('\n');
      expect(screenLiterals(file, code)).toEqual([]);
    });
    it('leaves a template literal with a value in it alone, since the words come from a variable', () => {
      expect(screenLiterals(file, 'export const A = () => <i aria-label={`${label} ${parent.id}`} />;\n')).toEqual([]);
    });
    it('answers a very long run quickly', () => {
      const long = `export const A = () => <p>${'word '.repeat(40_000)}</p>;\nconst x = <b title="${'a'.repeat(50_000)}`;
      const started = Date.now();
      screenLiterals(file, long);
      expect(Date.now() - started).toBeLessThan(1500);
    });
    it('looks only at screen components, not at tests or other folders', () => {
      expect(screenLiterals('apps/customer/src/screens/x/Room.test.tsx', `const A = () => <p>Send money now</p>;\n`)).toEqual([]);
      expect(screenLiterals('apps/customer/src/features/x/Room.tsx', `const A = () => <p>Send money now</p>;\n`)).toEqual([]);
      expect(screenLiterals('apps/customer/src/screens/x/model.ts', `export const a = 'Send money now';\n`)).toEqual([]);
    });
  });
});
