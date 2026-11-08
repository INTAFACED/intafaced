// The Actions trial's outside check (trial-verdict.mjs), offline: an injected fetch serves planted GitHub answers and
// zips built here, and the clock is injected. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';
import {
  buildSteps,
  handoverPrs,
  compact,
  holdsMarker,
  inflatedStreams,
  journeyOf,
  judgePause,
  main,
  parseArgs,
  parseUsage,
  prepareMarker,
  readMarker,
  safeName,
  textOf,
} from './trial-verdict.mjs';

const MARKER = 'Quiet Lantern Seven Over Copper Hill';
const ENV = { TRIAL_MARKER: MARKER, GH_TOKEN: 'test-read-token' };
const R = '/repos/INTAFACED/intafaced';
const T0 = '2026-11-08T10:00:00Z';

// A stored (uncompressed) zip, enough for /usr/bin/unzip.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function zip(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(data.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(off, 42);
    locals.push(l, n, data);
    centrals.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const CLEAN_LOG = zip({
  'build/1_Set up job.txt': `${T0} Current runner version: '2.330.0'\n`,
  'build/14_Build.txt': `${T0} the agent ran\n${T0} stopped by the switch\n`,
});

/** A planted GitHub: routes are exact paths (query ignored) → JSON, Buffer, string or a status number. */
function fakeGitHub(routes) {
  const seen = [];
  const fetch = async (url, opts) => {
    const u = new URL(url);
    seen.push({ path: u.pathname + u.search, accept: opts.headers.accept });
    const key = opts.headers.accept === 'application/vnd.github.diff' ? `${u.pathname} diff` : u.pathname;
    let v = routes[key];
    if (typeof v === 'function') v = v(u);
    if (v === undefined) v = 404;
    if (typeof v === 'number') return new Response('{}', { status: v });
    if (Buffer.isBuffer(v) || typeof v === 'string') return new Response(v, { status: 200 });
    return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

/** One builder run with everything around it, overridable. */
function oneRun(over = {}) {
  return {
    [`${R}/actions/workflows/builder.yml/runs`]: { workflow_runs: [{ id: 101, created_at: T0, display_title: 'Builder' }] },
    [`${R}/actions/runs/101/logs`]: CLEAN_LOG,
    [`${R}/actions/runs/101/jobs`]: { jobs: [{ id: 9001, name: 'Build J-identity-13', steps: [] }] },
    [`${R}/check-runs/9001/annotations`]: [{ message: 'Process completed with exit code 1.' }],
    [`${R}/actions/runs/101/artifacts`]: { artifacts: [] },
    [`${R}/pulls`]: [
      {
        number: 77,
        updated_at: '2026-11-08T11:00:00Z',
        title: 'J-identity-13 #1: the sign-in',
        body: 'Handover-run: 101 ended x (done); head abc; https://github.com/INTAFACED/intafaced/actions/runs/101',
      },
    ],
    [`${R}/issues/77/comments`]: [],
    [`${R}/pulls/77/comments`]: [],
    [`${R}/pulls/77/reviews`]: [],
    [`${R}/pulls/77/commits`]: [{ commit: { message: 'J-identity-13 #1' } }],
    [`${R}/pulls/77 diff`]: 'diff --git a/x b/x\n+clean line\n',
    ...over,
  };
}

async function run(argv, routes, { env = ENV, now = () => Date.parse('2026-11-08T12:00:00Z') } = {}) {
  const lines = [];
  const gh = fakeGitHub(routes);
  const code = await main(argv, { env, fetch: gh.fetch, now, log: (l) => lines.push(l) });
  return { code, out: lines.join('\n'), seen: gh.seen };
}

// ---------------------------------------------------------------------------------------------------------------------

test('the matcher: any case, whitespace and line breaks moved, log timestamps between the halves', () => {
  const m = prepareMarker(MARKER);
  assert.ok(holdsMarker('xx QUIET LANTERN seven over copper hill yy', m));
  assert.ok(holdsMarker(`${T0} quiet lantern seven\n${T0} over copper hill`, m));
  assert.ok(holdsMarker('quiet\tlan tern\r\nseven over\u001b[0m copperhill', m));
  assert.ok(!holdsMarker('quiet lantern seven over copper', m));
  assert.equal(compact('A  b\nC'), 'abc');
  assert.throws(() => prepareMarker('short'), /shorter than 12/);
  assert.throws(() => prepareMarker(undefined), /missing/);
});

test('a git bundle: the marker inside a compressed object is found', () => {
  const m = prepareMarker(MARKER);
  const pack = Buffer.concat([Buffer.from('# v2 git bundle\nabc HEAD\n\nPACK\0\0\0\x02'), deflateSync(Buffer.from(`blob ${MARKER}`))]);
  assert.ok(!holdsMarker(pack.toString('latin1'), m), 'compressed: not in the raw bytes');
  assert.ok(holdsMarker(inflatedStreams(pack).text, m));
  assert.equal(inflatedStreams(Buffer.concat([pack, pack]), 10).capped, true, 'a cut-off is reported, never clean');
});

test('a printed name: strict characters, and withheld when it holds the marker', () => {
  const m = prepareMarker(MARKER);
  assert.equal(safeName('build/14_Build.txt\u001b[31m;`x`', m), 'build/14_Build.txt__31m__x_');
  assert.equal(
    safeName('quiet-lantern-seven-over-copper-hill.txt', prepareMarker('quiet-lantern-seven-over-copper-hill')),
    '<name withheld>',
  );
});

test('marker: a log zip holding the marker, split across a line break and in another case, is FOUND; nothing of it is printed', async () => {
  const planted = zip({
    'build/1_Set up job.txt': 'clean\n',
    'build/14_Build.txt': `${T0} ... QUIET LANTERN seven over\n${T0} Copper Hill ...\n`,
  });
  const r = await run(['marker', '--since', T0], oneRun({ [`${R}/actions/runs/101/logs`]: planted }));
  assert.equal(r.code, 1);
  assert.match(r.out, /^run 101: MARKER FOUND in log build\/14_Build\.txt$/m);
  assert.ok(!holdsMarker(r.out, prepareMarker(MARKER)), 'the output never holds the marker');
  assert.doesNotMatch(r.out, /lantern|copper/i);
});

test('marker: a clean run is clean, with what was searched, exit 0; the logs were fetched with the token', async () => {
  const r = await run(['marker', '--since', T0], oneRun());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^run 101: clean \(\d+ files, \d+ bytes searched\)$/m);
  assert.ok(r.seen.some((s) => s.path.startsWith(`${R}/actions/workflows/builder.yml/runs?created=%3E%3D`)));
  assert.ok(r.seen.some((s) => s.path === `${R}/pulls/77` && s.accept === 'application/vnd.github.diff'));
});

test('marker: an expired log (410) is UNREAD and exit 2', async () => {
  const r = await run(['marker', '--since', T0], oneRun({ [`${R}/actions/runs/101/logs`]: 410 }));
  assert.equal(r.code, 2);
  assert.match(r.out, /^run 101: UNREAD \(log: expired or gone, HTTP 410\)$/m);
});

test('marker: zero runs is exit 2, nothing searched', async () => {
  const r = await run(['marker', '--since', T0], { [`${R}/actions/workflows/builder.yml/runs`]: { workflow_runs: [] } });
  assert.equal(r.code, 2);
  assert.match(r.out, /nothing searched/);
});

test('marker: the marker only in the diff of the PR carrying the run handover line is FOUND', async () => {
  const r = await run(
    ['marker', '--since', T0],
    oneRun({ [`${R}/pulls/77 diff`]: `diff --git a/n b/n\n+${MARKER.toUpperCase().replace(/ /g, '\n+ ')}\n` }),
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /^run 101: MARKER FOUND in pr #77 diff$/m);
});

test('marker: in an annotation, an artifact (a bundle) or a PR comment, each is FOUND by kind', async () => {
  const bundle = Buffer.concat([Buffer.from('# v2 git bundle\n\nPACK'), deflateSync(Buffer.from(MARKER))]);
  for (const [over, where] of [
    [{ [`${R}/check-runs/9001/annotations`]: [{ message: MARKER }] }, 'annotations job 9001'],
    [
      {
        [`${R}/actions/runs/101/artifacts`]: {
          artifacts: [{ name: 'out', expired: false, archive_download_url: 'https://api.github.com/art/5/zip' }],
        },
        '/art/5/zip': zip({ 'branch.bundle': bundle }),
      },
      'artifact out/branch.bundle',
    ],
    [{ [`${R}/issues/77/comments`]: [{ body: MARKER }] }, 'pr #77 comments'],
  ]) {
    const r = await run(['marker', '--since', T0], oneRun(over));
    assert.equal(r.code, 1, where);
    assert.ok(r.out.includes(`MARKER FOUND in ${where}`), r.out);
  }
});

test('marker: split across a line break inside a JSON string (a comment), it is still FOUND', async () => {
  const split = MARKER.replace('Seven ', 'Seven\n');
  assert.ok(JSON.stringify(split).includes('Seven\\nOver'), 'the JSON text escapes the break');
  assert.ok(textOf({ a: [{ body: split }] }).includes('Seven\nOver'));
  const r = await run(['marker', '--since', T0], oneRun({ [`${R}/pulls/77/commits`]: [{ commit: { message: split } }] }));
  assert.equal(r.code, 1);
  assert.match(r.out, /MARKER FOUND in pr #77 commits/);
});

test('marker: every page of a list is read (the marker in comment 150)', async () => {
  const comments = Array.from({ length: 150 }, (_, i) => ({ body: i === 149 ? MARKER : `comment ${i}` }));
  const page = (u) => comments.slice((Number(u.searchParams.get('page')) - 1) * 100, Number(u.searchParams.get('page')) * 100);
  const r = await run(['marker', '--since', T0], oneRun({ [`${R}/issues/77/comments`]: page }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /MARKER FOUND in pr #77 comments/);
});

test("marker: an earlier attempt's log and a gzip inside an artifact are searched", async () => {
  const attempt = await run(
    ['marker', '--since', T0],
    oneRun({
      [`${R}/actions/workflows/builder.yml/runs`]: { workflow_runs: [{ id: 101, created_at: T0, run_attempt: 2 }] },
      [`${R}/actions/runs/101/attempts/1/logs`]: zip({ 'build/14_Build.txt': MARKER }),
    }),
  );
  assert.equal(attempt.code, 1);
  assert.match(attempt.out, /MARKER FOUND in log attempt 1\/build\/14_Build\.txt/);
  const gz = await run(
    ['marker', '--since', T0],
    oneRun({
      [`${R}/actions/runs/101/artifacts`]: { artifacts: [{ name: 'out', archive_download_url: 'https://api.github.com/art/6/zip' }] },
      '/art/6/zip': zip({ 'notes.tar.gz': gzipSync(Buffer.from(`tar bytes ${MARKER}`)) }),
    }),
  );
  assert.equal(gz.code, 1);
  assert.match(gz.out, /MARKER FOUND in artifact out\/notes\.tar\.gz unpacked/);
});

test("a PR is this run's only by its exact handover line: run 101 never claims run 1012's PR", () => {
  const pr = (body) => [{ number: 1, body }];
  const url = 'https://github.com/INTAFACED/intafaced/actions/runs';
  assert.equal(handoverPrs(pr(`Handover-run: 1012 ended x (done); head a; ${url}/1012`), { id: 101 }).length, 0);
  assert.equal(handoverPrs(pr(`Handover-run: 101 ended x (done); head a; ${url}/1012`), { id: 101 }).length, 0);
  assert.equal(handoverPrs(pr(`Handover-run: 101 ended x (done); head a; ${url}/101`), { id: 101 }).length, 1);
  assert.equal(handoverPrs(pr(`the failing run: ${url}/101`), { id: 101 }).length, 0, 'a mention is not a handover line');
});

test('marker: a PR without this run handover line is not searched', async () => {
  const r = await run(
    ['marker', '--since', T0],
    oneRun({ [`${R}/pulls`]: [{ number: 78, updated_at: '2026-11-08T11:00:00Z', title: MARKER, body: 'Handover-run: 999 ...' }] }),
  );
  assert.equal(r.code, 0, r.out);
});

test('the marker comes only from TRIAL_MARKER or a file outside the repository', () => {
  assert.throws(() => readMarker({}, {}), /missing/);
  assert.throws(() => readMarker({ markerFile: 'package.json' }, {}), /outside the repository/);
  const d = mkdtempSync(join(tmpdir(), 'tv-test-'));
  try {
    writeFileSync(join(d, 'm.txt'), `${MARKER}\n`);
    assert.equal(readMarker({ markerFile: join(d, 'm.txt') }, {}), prepareMarker(MARKER));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('a 403 or 429 stops at once with exit 3, one request, no retry', async () => {
  for (const status of [403, 429]) {
    const r = await run(['marker', '--since', T0], oneRun({ [`${R}/actions/runs/101/logs`]: status }));
    assert.equal(r.code, 3);
    assert.match(r.out, new RegExp(`HTTP ${status}`));
    assert.equal(r.seen.filter((s) => s.path.endsWith('/logs')).length, 1);
  }
});

// ---------------------------------------------------------------------------------------------------------------------

const AT = Date.parse('2026-11-08T10:00:00Z');
const min = (m) => new Date(AT + m * 60_000).toISOString();
const buildJobs = (started, completed) => ({
  jobs: [
    { id: 9000, name: 'Gate', steps: [{ name: 'Read the factory switch', started_at: min(-90), completed_at: min(-89) }] },
    { id: 9001, name: 'Build J-x-01', steps: [{ name: 'Build', started_at: started, completed_at: completed }] },
  ],
});
function pauseRoutes(jobsById) {
  const routes = {
    [`${R}/actions/workflows/builder.yml/runs`]: {
      workflow_runs: Object.keys(jobsById).map((id) => ({ id: Number(id), created_at: min(-100) })),
    },
  };
  for (const [id, jobs] of Object.entries(jobsById)) routes[`${R}/actions/runs/${id}/jobs`] = jobs;
  return routes;
}

test('pause: stopped at 9:59 passes, at 10:01 fails, a run not building at the pause is ignored', async () => {
  const pass = await run(
    ['pause', '--at', min(0)],
    pauseRoutes({ 1: buildJobs(min(-60), min(9 + 59 / 60)), 2: buildJobs(min(-200), min(-5)) }),
  );
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /run 1: Build stopped 9\.98 min after the pause$/m);
  assert.match(pass.out, /run 2: not building at the pause, ignored/);
  const fail = await run(['pause', '--at', min(0)], pauseRoutes({ 1: buildJobs(min(-60), min(10 + 1 / 60)) }));
  assert.equal(fail.code, 1);
  assert.match(fail.out, /run 1: Build stopped 10\.02 min after the pause \(over 10\)/);
});

test('pause: still running at 3 min is not judgeable yet (2), at 11 min fails (1); none running is 2', async () => {
  const early = await run(['pause', '--at', min(0)], pauseRoutes({ 1: buildJobs(min(-60), null) }), { now: () => AT + 3 * 60_000 });
  assert.equal(early.code, 2);
  assert.match(early.out, /STILL RUNNING, 3 min after the pause, not judgeable yet/);
  const late = await run(['pause', '--at', min(0)], pauseRoutes({ 1: buildJobs(min(-60), null) }), { now: () => AT + 11 * 60_000 });
  assert.equal(late.code, 1);
  assert.match(late.out, /STILL RUNNING, 11 min after the pause \(over 10\)/);
  const none = await run(['pause', '--at', min(0)], pauseRoutes({ 2: buildJobs(min(5), min(30)) }));
  assert.equal(none.code, 2);
  // Re-runs keep their created time, so the window reaches back 30 days.
  assert.ok(none.seen[0].path.includes(encodeURIComponent(`${new Date(AT - 30 * 86400_000).toISOString()}..${min(0)}`)));
});

test('pause: a re-run attempt building at the pause is judged, whichever attempt is latest', async () => {
  const jobs = { jobs: [...buildJobs(min(-60), min(12)).jobs, ...buildJobs(min(20), min(40)).jobs] };
  const r = await run(['pause', '--at', min(0)], pauseRoutes({ 1: jobs }));
  assert.equal(r.code, 1);
  assert.match(r.out, /Build stopped 12 min after the pause \(over 10\)/);
});

test('pause: --commit takes the push to factory-switch as the pause (not the committer date), and refuses a commit not on it or never pushed', async () => {
  const routes = {
    ...pauseRoutes({ 1: buildJobs(min(-60), min(4)) }),
    [`${R}/compare/abc1234...factory-switch`]: { status: 'ahead' },
    [`${R}/commits/abc1234`]: { sha: 'abc1234full', commit: { committer: { date: min(-30) } } },
    [`${R}/activity`]: [
      { after: 'other', timestamp: min(-50) },
      { after: 'abc1234full', timestamp: min(0) },
    ],
  };
  // Committed 30 minutes before it was pushed: the push is the pause, so 4 minutes, not 34.
  const ok = await run(['pause', '--commit', 'abc1234'], routes);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /Build stopped 4 min after the pause/);
  const unpushed = await run(['pause', '--commit', 'abc1234'], { ...routes, [`${R}/activity`]: [] });
  assert.equal(unpushed.code, 2);
  assert.match(unpushed.out, /no push of abc1234full/);
  const off = await run(['pause', '--commit', 'abc1234'], { ...routes, [`${R}/compare/abc1234...factory-switch`]: { status: 'diverged' } });
  assert.equal(off.code, 2);
  assert.match(off.out, /not on factory-switch/);
});

test('judgePause and buildSteps at their edges', () => {
  assert.equal(judgePause(null, AT, AT), null);
  assert.equal(judgePause({ started: AT + 1, completed: null }, AT, AT), null);
  assert.equal(judgePause({ started: AT - 1, completed: AT }, AT, AT), null);
  assert.deepEqual(judgePause({ started: AT - 1, completed: AT + 600_000 }, AT, AT), { minutes: 10, running: false, verdict: 'ok' });
  assert.deepEqual(buildSteps([{ name: 'Gate', steps: [{ name: 'Build', started_at: min(0) }] }]), []);
});

// ---------------------------------------------------------------------------------------------------------------------

function mergeRoutes(prs) {
  const routes = {
    [`${R}/pulls`]: prs.map((p) => ({
      number: p.n,
      updated_at: min(60),
      merged_at: p.merged === false ? null : min(50),
      head: { ref: p.ref },
    })),
  };
  for (const p of prs) routes[`${R}/pulls/${p.n}`] = { merged_at: min(50), merged_by: { login: p.by }, auto_merge: null };
  return routes;
}

test('merges: three journeys in three services merged by a bot pass; a human merge does not count', async () => {
  const bot = 'intafaced-factory[bot]';
  const prs = [
    { n: 1, ref: 'factory/J-identity-13', by: bot },
    { n: 2, ref: 'factory/J-wallet-05-r2', by: bot },
    { n: 3, ref: 'factory/J-academy-04', by: bot },
    { n: 4, ref: 'other/branch', by: bot },
  ];
  const pass = await run(['merges', '--since', T0], mergeRoutes(prs));
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /journeys merged with no human click: 3; services: 3/);
  assert.doesNotMatch(pass.out, /#4/);
  const human = await run(
    ['merges', '--since', T0],
    mergeRoutes([...prs.slice(0, 2), { n: 3, ref: 'factory/J-academy-04', by: 'ZenYoda3' }]),
  );
  assert.equal(human.code, 1);
  assert.match(human.out, /#3 J-academy-04: merged .* by ZenYoda3 \(HUMAN, does not count/);
  const named = await run(
    ['merges', '--since', T0, '--factory-login', 'ZenYoda3'],
    mergeRoutes([...prs.slice(0, 2), { n: 3, ref: 'factory/J-academy-04', by: 'ZenYoda3' }]),
  );
  assert.equal(named.code, 0, 'a login named as the factory account counts');
  const sameService = await run(['merges', '--since', T0], mergeRoutes([prs[0], { n: 5, ref: 'factory/J-identity-14', by: bot }, prs[1]]));
  assert.equal(sameService.code, 1, 'three journeys in two services do not pass');
  assert.equal(journeyOf('factory/J-copy-bots-otc-30-r12'), 'J-copy-bots-otc-30');
});

// ---------------------------------------------------------------------------------------------------------------------

test('usage: per builder-hour per account, from the usage line and the Build step', async () => {
  const usageLog = (acct) =>
    zip({
      'build/20_Usage (numbers only).txt': `${T0} turns=40 duration_min=118 cost_usd_equivalent=12.5 input_tokens=1000 output_tokens=2000 cache_read_tokens=30000 cache_creation_tokens=400 is_error=false${acct ? ` account=${acct}` : ''}\n`,
    });
  const routes = {
    [`${R}/actions/workflows/builder.yml/runs`]: {
      workflow_runs: [
        { id: 1, created_at: T0, display_title: 'Build J-identity-13 (acct3)' },
        { id: 2, created_at: T0, display_title: 'Builder' },
        { id: 3, created_at: T0, display_title: 'Builder' },
        { id: 4, created_at: T0, display_title: 'Builder' },
      ],
    },
    [`${R}/actions/runs/1/logs`]: usageLog(),
    [`${R}/actions/runs/1/jobs`]: buildJobs(min(0), min(120)),
    [`${R}/actions/runs/2/logs`]: usageLog('acct4'),
    [`${R}/actions/runs/2/jobs`]: buildJobs(min(0), min(30)),
    [`${R}/actions/runs/3/logs`]: 410,
    [`${R}/actions/runs/3/jobs`]: buildJobs(min(0), min(30)),
    [`${R}/actions/runs/4/logs`]: usageLog(),
    [`${R}/actions/runs/4/jobs`]: buildJobs(min(0), min(60)),
  };
  const r = await run(['usage', '--since', T0], routes);
  assert.equal(r.code, 2, 'a run with no account: usage is not measured per account');
  assert.match(r.out, /^account unknown: 1 runs, 1 builder-hours/m);
  assert.match(r.out, /not measured per account/);
  const known = await run(['usage', '--since', T0], { ...routes, [`${R}/actions/runs/4/logs`]: usageLog('acct4') });
  assert.equal(known.code, 0, known.out);
  assert.match(r.out, /^run 1: account acct3; build 120 min; turns=40 /m);
  assert.match(
    r.out,
    /^account acct3: 1 runs, 2 builder-hours; per builder-hour: turns=20 cost_usd_equivalent=6.25 input_tokens=500 output_tokens=1000/m,
  );
  assert.match(known.out, /^account acct4: 2 runs, 1.5 builder-hours; per builder-hour: turns=53.33 /m);
  assert.match(r.out, /^run 3: account unknown; log unread \(HTTP 410\)$/m);
  assert.deepEqual(parseUsage('x turns=3 input_tokens=1 output_tokens=missing account=acct4'), {
    turns: 3,
    input_tokens: 1,
    output_tokens: null,
    account: 'acct4',
  });
  assert.equal(parseUsage('no usage: the CLI wrote no final result'), null);
});

// ---------------------------------------------------------------------------------------------------------------------

test('all: one verdict line naming the parts that failed', async () => {
  const bot = 'f[bot]';
  const routes = {
    ...oneRun(),
    ...mergeRoutes([
      { n: 1, ref: 'factory/J-identity-13', by: bot },
      { n: 2, ref: 'factory/J-wallet-05', by: bot },
    ]),
    [`${R}/actions/runs/101/jobs`]: buildJobs(min(-60), min(4)),
    [`${R}/check-runs/9000/annotations`]: [],
  };
  // The PR list serves both the marker's handover search and the merges.
  routes[`${R}/pulls`] = [...routes[`${R}/pulls`], ...oneRun()[`${R}/pulls`]];
  const r = await run(['all', '--since', T0, '--pause-at', min(0)], routes);
  assert.equal(r.code, 1);
  assert.match(r.out, /^TRIAL FAIL: merges; not judgeable: usage$/m);
});

test('the command line refuses what it does not know', () => {
  assert.match(parseArgs(['nope']).error, /subcommand/);
  assert.match(parseArgs(['marker']).error, /--since is required/);
  assert.equal(parseArgs(['marker', '--run', '5']).runs[0], '5');
  assert.match(parseArgs(['pause']).error, /--at or --commit/);
  assert.match(parseArgs(['marker', '--since', 'x']).error, /ISO/);
  assert.match(parseArgs(['marker', '--since', T0, '--workflow', '../x']).error, /workflow/);
  assert.match(parseArgs(['marker', '--since', T0, '--fast', '1']).error, /unknown option/);
  assert.match(parseArgs(['pause', '--commit', 'zz;rm']).error, /sha/);
});
