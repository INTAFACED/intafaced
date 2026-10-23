import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * HM-shell-03: in the shell, Home, notifications, public and Web3 copy, "connected" belongs to an outside dependency on the
 * allowlist, and that case is the shared `ServiceOffNotice` ("… It is switched off in this build."). Our own missing back end
 * is never "not connected": it says what is not served or not built. The lines below were on main when this test landed; each
 * is its owner's to reword, and the list can only shrink.
 */
const src = fileURLToPath(new URL('..', import.meta.url));
const FOLDERS = ['app', 'screens/home', 'screens/notifications', 'features/public', 'features/protocol'];
const WORDING =
  /\b(?:is|are) not connected\b|\bisn[’']t connected\b|\bnot connected (?:here|on this platform|in this build)\b|\bis connected\b/i;

const KNOWN = new Set([
  'features/public/sign-up-copy.ts: vendor.sms',
  'features/protocol/copy.ts: serviceNotConnected',
  'features/protocol/copy.ts: blk_source_not_connected',
  'features/protocol/copy.ts: blk_amm_unwired',
  'features/protocol/copy.ts: blk_no_execution_path',
  'features/protocol/copy.ts: chipNotConnected',
  'screens/notifications/centre-copy.ts: cellNotConnected',
  'screens/notifications/alerts-copy.ts: evalDark',
  'features/public/public-copy.ts: Available funds stay distinct from funds on hold. Missing prices stay missing. Where a service or rail is not connected, the product explains the limitation before you act.',
  'features/public/public-copy.ts: Partner intake is not connected',
  'features/public/public-copy.ts: Campaign catalogue is not connected',
]);

function copyFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? copyFiles(join(dir, entry.name))
      : /copy\.ts$/.test(entry.name) && !entry.name.includes('.test.')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** Every English source entry (`key: 'text'`) whose text uses own-gap "connected" wording, as `file: key`. */
function hits(): string[] {
  const found = new Set<string>();
  for (const folder of FOLDERS)
    for (const file of copyFiles(join(src, folder))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^ {2}(?:'([^']+)'|([\w.]+)):\s*\n?\s*'([^']*)'/gm)) {
        const key = match[1] ?? match[2]!;
        if (WORDING.test(match[3]!)) found.add(`${relative(src, file)}: ${key}`);
      }
    }
  return [...found].sort();
}

describe('own-gap wording in the shell (HM-shell-03)', () => {
  it('adds no "is not connected" wording beyond the lines listed for their owners', () => {
    expect(hits().filter((hit) => !KNOWN.has(hit))).toEqual([]);
  });

  it('keeps the list honest: every listed line still exists, so a reworded one is taken off', () => {
    const now = new Set(hits());
    expect([...KNOWN].filter((hit) => !now.has(hit))).toEqual([]);
  });
});
