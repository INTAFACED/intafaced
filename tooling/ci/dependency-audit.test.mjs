/**
 * Unit test for the dependency-audit allowlist expiry rule.
 * Run: node --test tooling/ci/dependency-audit.test.mjs   (no network, no pnpm)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_EXPIRY_DAYS, KNOWN, checkAllowlistExpiry } from './dependency-audit.mjs';

const entry = (over = {}) => ({ severity: 'high', module: 'x', owner: 'someone', expires: '2026-12-01', note: 'why', ...over });
const TODAY = '2026-10-13';

test('a dated, owned entry inside the window passes', () => {
  const r = checkAllowlistExpiry({ A: entry() }, TODAY);
  assert.deepEqual(r, { expired: [], invalid: [] });
});

test('the expiry day itself is still valid; the next day fails', () => {
  assert.deepEqual(checkAllowlistExpiry({ A: entry({ expires: '2026-10-13' }) }, '2026-10-13').expired, []);
  const r = checkAllowlistExpiry({ A: entry({ expires: '2026-10-13' }) }, '2026-10-14');
  assert.equal(r.expired.length, 1);
  assert.equal(r.expired[0].id, 'A');
});

test('an expired entry fails even when everything else is fine', () => {
  const r = checkAllowlistExpiry({ OLD: entry({ expires: '2026-01-01' }), OK: entry() }, TODAY);
  assert.deepEqual(
    r.expired.map((x) => x.id),
    ['OLD'],
  );
  assert.deepEqual(r.invalid, []);
});

test('missing or malformed dates, owner and note are rejected', () => {
  const r = checkAllowlistExpiry(
    {
      NO_DATE: entry({ expires: undefined }),
      BAD_DATE: entry({ expires: '13/10/2026' }),
      FAKE_DATE: entry({ expires: '2026-02-31' }),
      NO_OWNER: entry({ owner: '' }),
      NO_NOTE: entry({ note: ' ' }),
    },
    TODAY,
  );
  const reasons = Object.fromEntries(r.invalid.map((x) => [x.id, x.reason]));
  assert.match(reasons.NO_DATE, /expires/);
  assert.match(reasons.BAD_DATE, /expires/);
  assert.match(reasons.FAKE_DATE, /expires/);
  assert.match(reasons.NO_OWNER, /owner/);
  assert.match(reasons.NO_NOTE, /note/);
});

test('more than 90 days out needs a written longReason, and never more than 365', () => {
  const far = '2027-06-01'; // ~231 days
  assert.equal(checkAllowlistExpiry({ A: entry({ expires: far }) }, TODAY).invalid.length, 1);
  assert.equal(checkAllowlistExpiry({ A: entry({ expires: far, longReason: 'vendor ships the patch in Q2' }) }, TODAY).invalid.length, 0);
  assert.equal(checkAllowlistExpiry({ A: entry({ expires: '2028-01-01', longReason: 'x' }) }, TODAY).invalid.length, 1);
});

test('an unreal clock throws instead of letting every entry pass', () => {
  for (const bad of ['9999-99-99', '2026-13-01', '', 'x']) {
    assert.throws(() => checkAllowlistExpiry({ A: entry() }, bad), /not a real date/, bad);
  }
  assert.throws(() => checkAllowlistExpiry({ A: entry() }, new Date('invalid')));
});

test('accepts a Date as the clock', () => {
  const r = checkAllowlistExpiry({ A: entry({ expires: '2026-10-12' }) }, new Date('2026-10-13T08:00:00Z'));
  assert.equal(r.expired.length, 1);
});

test('the real allowlist is well-formed (clock pinned to 2026-10-13), and fails once the clock passes its last date', () => {
  // Pinned on purpose: this checks the SHAPE of the list. Real-clock expiry is
  // the audit's job, so a lapsed date fails there once, not twice.
  const now = checkAllowlistExpiry(KNOWN, TODAY);
  assert.deepEqual(now, { expired: [], invalid: [] }, JSON.stringify(now));
  const last = Object.values(KNOWN)
    .map((e) => e.expires)
    .sort()
    .at(-1);
  const after = new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000);
  const later = checkAllowlistExpiry(KNOWN, after);
  assert.equal(later.expired.length, Object.keys(KNOWN).length, 'every entry is expired one day after the last date');
  assert.ok(MAX_EXPIRY_DAYS <= 90);
});

test('the CLI fails the run on an expired entry, and passes when none is expired', () => {
  // Hermetic: a stub `pnpm` that reports the exact advisories on the list, so the
  // only thing that can fail the run is expiry.
  const dir = mkdtempSync(join(tmpdir(), 'dep-audit-'));
  try {
    const advisories = Object.fromEntries(
      Object.entries(KNOWN).map(([id, e]) => [id, { github_advisory_id: id, severity: e.severity, module_name: e.module }]),
    );
    writeFileSync(join(dir, 'pnpm'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ advisories })}\nEOF\n`);
    chmodSync(join(dir, 'pnpm'), 0o755);
    const run = (extraEnv) =>
      spawnSync(process.execPath, [fileURLToPath(new URL('./dependency-audit.mjs', import.meta.url))], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...extraEnv },
      });

    // These two read the REAL clock. Once an entry has really expired the
    // audit is supposed to fail, so the "passes today" assertions would only
    // restate that; skip them then instead of going red for the wrong reason.
    const reallyExpired = checkAllowlistExpiry(KNOWN).expired.length > 0;
    if (!reallyExpired) {
      const ok = run({});
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    }

    const late = run({ DEPENDENCY_AUDIT_TODAY: '2099-01-01' });
    assert.equal(late.status, 1);
    assert.match(late.stderr, /EXPIRED/);

    // The override only moves the clock forward: a past date changes nothing.
    if (!reallyExpired) {
      const past = run({ DEPENDENCY_AUDIT_TODAY: '2000-01-01' });
      assert.equal(past.status, 0, past.stdout + past.stderr);
    }

    // A pattern-valid but unreal date must fail loudly, not make every entry pass.
    for (const bad of ['9999-99-99', '2099-02-31', 'tomorrow']) {
      const r = run({ DEPENDENCY_AUDIT_TODAY: bad });
      assert.equal(r.status, 1, `${bad}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /not a real/);
    }

    // Run through a symlink: main() must still run (it used to be skipped, exit 0).
    const link = join(dir, 'audit-link.mjs');
    symlinkSync(fileURLToPath(new URL('./dependency-audit.mjs', import.meta.url)), link);
    const viaLink = spawnSync(process.execPath, [link], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEPENDENCY_AUDIT_TODAY: '2099-01-01' },
    });
    assert.equal(viaLink.status, 1, 'symlinked run must execute main() and report the expiry');
    assert.match(viaLink.stderr, /EXPIRED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importing the module does not run an audit (no side effects)', () => {
  // If main() ran on import it would spawn `pnpm audit` and likely exit; reaching
  // this line proves it did not. Also confirm the file is the one we think.
  assert.ok(fileURLToPath(import.meta.url).endsWith('dependency-audit.test.mjs'));
});
