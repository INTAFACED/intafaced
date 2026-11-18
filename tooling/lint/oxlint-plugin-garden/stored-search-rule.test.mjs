// garden/no-raw-stored-search on planted files: the two searches that failed by chance (a card row's hash holding a PIN's
// digits, a details event's uuid holding a phone's) fire, as written before and after their hand-written masks, and name
// the helper; the same searches through storedText, a search over a value that is not serialized, a long literal and a
// file outside the tests do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden(no-raw-stored-search)';

/** Each planted file's findings of this rule, as unix-format lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-stored-search-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(RULE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const BANK = 'services/svc-bank/src/cards/cards-procedures.test.ts';
const IDENTITY = 'services/svc-identity/src/controls/customer-details.pg.test.ts';

test('the two searches that failed by chance fire, with and without their hand masks, and name the helper', skip, () => {
  const out = findings({
    [BANK]: [
      'const stored = (',
      '  JSON.stringify(await sql`SELECT * FROM bank.card_authorizations`) + JSON.stringify(await sql`SELECT * FROM bank.card_secret_audits`)',
      ')',
      `  .replace(/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/gi, '"<uuid>"')`,
      `  .replace(/"\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z"/g, '"<time>"');`,
      "expect(stored).not.toContain('4321');",
      "expect(stored).not.toContain('8642');",
    ].join('\n'),
    [IDENTITY]: [
      'const events = await db.sql`SELECT result FROM customer_detail_events`;',
      "expect(JSON.stringify(events)).not.toContain('7946');",
      'const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;',
      "expect(JSON.stringify(events).replace(uuid, '<uuid>')).not.toContain('7946');",
    ].join('\n'),
  });
  assert.equal(out.length, 4, out.join('\n'));
  assert.equal(out.filter((l) => l.startsWith(BANK)).length, 2);
  assert.equal(out.filter((l) => l.startsWith(IDENTITY)).length, 2);
  for (const line of out) assert.match(line, /storedText\(\.\.\.\) from @intafaced\/db\/testing \(packages\/db\/src\/testing\.ts\)/u);
});

test('storedText, a value not serialized, a long literal and a file outside the tests pass', skip, () => {
  const out = findings({
    [BANK]: [
      "import { storedText } from '@intafaced/db/testing';",
      'const stored = storedText(await sql`SELECT * FROM bank.card_authorizations`, await sql`SELECT * FROM bank.card_secret_audits`);',
      "expect(stored).not.toContain('4321');",
      "expect(storedText(events)).not.toContain('7946');",
      "expect(rows.map((r) => r.fee)).not.toContain('10');",
      "expect(JSON.stringify(rows)).not.toContain('Leeds');",
      "expect(JSON.stringify(rows)).not.toContain('447700900000');",
      "expect(JSON.stringify(rows)).toContain('4321');",
    ].join('\n'),
    'services/svc-bank/src/cards/cards.ts': "expect(JSON.stringify(rows)).not.toContain('4321');",
  });
  assert.deepEqual(out, []);
});

test('a name is read where it is declared: a storedText const passes beside a JSON.stringify const of the same name', skip, () => {
  const out = findings({
    [BANK]: [
      "it('a', async () => { const stored = JSON.stringify(rows); expect(stored).not.toContain('1234'); });",
      "it('b', async () => { const stored = storedText(rows); expect(stored).not.toContain('4321'); });",
    ].join('\n'),
  });
  assert.equal(out.length, 1, out.join('\n'));
  assert.match(out[0], /'1234'/u);
});
