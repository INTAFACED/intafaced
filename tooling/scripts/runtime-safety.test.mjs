import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { isGitHubRefusal } from './github-refusal.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const node = process.execPath;

assert.equal(isGitHubRefusal({ stderr: 'HTTP 403: forbidden' }), true);
assert.equal(isGitHubRefusal({ message: 'HTTP 429: rate limited' }), true);
assert.equal(isGitHubRefusal({ statusCode: 403 }), true);
assert.equal(isGitHubRefusal({ response: { status: 429 } }), true);
assert.equal(isGitHubRefusal({ stderr: 'HTTP/2 403 Forbidden' }), true);
assert.equal(isGitHubRefusal({ stderr: '429 Too Many Requests' }), true);
assert.equal(isGitHubRefusal({ stderr: 'HTTP 503: service unavailable' }), false);
assert.equal(
  isGitHubRefusal({ stderr: 'HTTP 503: service unavailable', message: 'Command failed: gh issue create --title "HTTP 403 guide"' }),
  false,
);
assert.equal(isGitHubRefusal({ message: 'Could not inspect pull request #403' }), false);
assert.equal(isGitHubRefusal({ stderr: 'Invalid path /repos/org/repo/issues/429' }), false);

const fakeGh = `#!/bin/sh
count_file="$GH_CALL_LOG.count"
count=0
if [ -f "$count_file" ]; then read count < "$count_file"; fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"
body=''
if [ "$GH_FIXTURE_MODE" = setup-success ] && [ "$count" -eq 2 ]; then body=$(/bin/cat); fi
printf '%s\\t%s\\n' "$count" "$* $body" >> "$GH_CALL_LOG"
case "$GH_FIXTURE_MODE:$count" in
  setup-fail403:1|setup-success:1) printf '%s\\n' 'Phantom-X-007/intafaced'; exit 0 ;;
  setup-fail403:2) printf '%s\\n' 'HTTP 403: forbidden' >&2; exit 1 ;;
  sync-fail429:1) printf '%s\\n' '[]'; exit 0 ;;
  sync-fail429:2) printf '%s\\n' 'HTTP 429: rate limit exceeded' >&2; exit 1 ;;
esac
printf '%s\\n' '{}'
`;
const fakeGit = '#!/bin/sh\nexit 1\n';

function run(script, args, mode) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-refusal-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, content] of [
    ['gh', fakeGh],
    ['git', fakeGit],
  ]) {
    const path = join(bin, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  const log = join(dir, 'calls.log');
  const result = spawnSync(node, [script, ...args], {
    cwd: root,
    env: { PATH: bin, GH_FIXTURE_MODE: mode, GH_CALL_LOG: log },
    encoding: 'utf8',
    timeout: 15000,
  });
  let calls = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  return { result, calls };
}

// Setup's permissive branch-protection fallback must stop on HTTP 403.
{
  const t = run(join(root, 'tooling/scripts/setup-github.mjs'), [], 'setup-fail403');
  assert.equal(t.result.status, 1, t.result.stderr);
  assert.equal(t.calls.length, 2);
  assert.match(t.result.stderr, /403/);
}

// Stub-only success proves the proposed setup settings without contacting GitHub.
{
  const t = run(join(root, 'tooling/scripts/setup-github.mjs'), [], 'setup-success');
  assert.equal(t.result.status, 0, t.result.stderr);
  const protection = t.calls[1];
  assert.match(protection, /Gitleaks/);
  assert.match(protection, /Dependency audit/);
  assert.match(protection, /Doctrine gates/);
  assert.match(protection, /"strict":false/);
  assert.match(protection, /"required_approving_review_count":0/);
  const merge = t.calls.find((call) => call.includes('allow_squash_merge'));
  assert.ok(merge, 'setup sends the merge settings');
  assert.match(merge, /delete_branch_on_merge=false/);
  assert.match(merge, /allow_auto_merge=false/);
  assert.doesNotMatch(merge, /(delete_branch_on_merge|allow_auto_merge)=true/);
}

// Issue-sync's permissive milestone-creation fallback must stop on HTTP 429.
{
  const t = run(join(root, 'tooling/scripts/sync-github-issues.mjs'), [], 'sync-fail429');
  assert.equal(t.result.status, 1, t.result.stderr);
  assert.equal(t.calls.length, 2);
  assert.match(t.result.stderr, /429/);
}

console.log('2 refusal-stop paths, stubbed setup policy, and 10 classifier cases passed; PATH contained only temporary gh/git stubs.');
