// The daily Hyperliquid recordings pull request reaching the CI review (ci-review.mjs summarizeRecordings, through
// summarizeGenerated; test-judge.mjs ciSource given the diff the review read). intafaced #11192: four recordings, a
// 5,282,119-byte compare diff, over what MAX_PARTS parts of MAX_DIFF_BYTES carry, so the review could only FAIL it
// ("split the pull request"), and the test part's second read of the same diff closed (`UND_ERR_SOCKET other side
// closed`) before either verdict was written. Built here as git builds it, in a repository of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobs, MAX_DIFF_BYTES, MAX_PARTS, splitDiff, summarizeGenerated, writeReviewInputs } from './ci-review.mjs';
import { ciSource } from './test-judge.mjs';

const DIR = 'packages/venue-hyperliquid/recordings';
const HOUSE = `0x${'116d8f77'.repeat(5)}`;
const briefs = {
  reviewBrief: readFileSync(new URL('./ci-review/REVIEW.md', import.meta.url), 'utf8'),
  testsBrief: readFileSync(new URL('./test-judge/JUDGE.md', import.meta.url), 'utf8'),
};
const never = async () => assert.fail('no step words are read for a change no test part applies to');

// A day's recording: the large listings the venue answers every run (their prices move daily), then the trader's calls.
const hex = (n, day) => (n * 2654435761 + day * 40503).toString(16).padStart(8, '0').slice(-8);
const listing = (day, n) => ({
  universe: Array.from({ length: n }, (_, i) => ({ name: `@${i}`, tokens: [i, 0], index: i, isCanonical: false })),
  tokens: Array.from({ length: n }, (_, i) => ({
    name: `TOK${i}`,
    szDecimals: 2,
    weiDecimals: 8,
    index: i,
    evmContract: { address: `0x${hex(i, 0).repeat(5)}`, evm_extra_wei_decimals: 0 },
    fullName: null,
    deployerTradingFeeShare: `0.${day}`,
  })),
});
const recording = (name, day, { status = 200, extra = [], trader = '<trader>' } = {}) => ({
  label: 'TEST',
  note: `TEST answers of the Hyperliquid test network, recorded live by LOCAL_STACK_USER_VENUE=hl-testnet for ${name}.`,
  trader,
  calls: [
    { path: '/info', request: { type: 'spotMeta' }, status: 200, answer: listing(day, 2600), source: 'testnet' },
    {
      path: '/info',
      request: { type: 'perpDexs' },
      status: 200,
      answer: Array.from({ length: 289 }, (_, i) => ({
        name: `dex${i}`,
        deployer: `0x${hex(i, 1).repeat(5)}`,
        oracleUpdater: null,
        markPx: `${day}.${i}`,
      })),
      source: 'testnet',
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      path: '/info',
      request: { type: 'clearinghouseState', user: i % 2 ? '<trader>' : HOUSE },
      status: 200,
      answer: { marginSummary: { accountValue: '110.0' }, assetPositions: [], time: 1795813204162 + i },
      source: 'testnet',
    })),
    {
      path: '/exchange',
      request: { action: { type: 'order', orders: [{ a: 4, b: true, p: '1716.4', s: '0.0073', r: false }] }, nonce: 1795813204162 + day },
      status,
      answer: {
        status: 'ok',
        response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.0073', avgPx: '1716.4', oid: 47 + day } }] } },
      },
      source: 'testnet',
    },
    ...extra,
  ],
});
// As tooling/scripts/local-test-venue.mjs writes it.
const pretty = (r) => `${JSON.stringify(r, null, 2)}\n`;

/** A repository with `before` committed and then `after`; its diff as the compare API gives it, and its blobs. */
const repo = (before, after) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-review-recordings-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  const commit = (files, message) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      if (text === null) rmSync(join(root, p));
      else writeFileSync(join(root, p), text);
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  const base = commit(before, 'base');
  const head = commit(after, 'head');
  const diff = git('-c', 'diff.renames=true', 'diff', '--no-color', '--no-ext-diff', `${base}...${head}`);
  return { root, base, head, diff, readBlob: gitBlobs(root), done: () => rmSync(root, { recursive: true }) };
};

/** #11192's shape: one recording changed in place (J-derivatives-01, on main already), three added. */
const daily = (overNow = {}) => {
  const names = ['J-cex-spot-01-hl-venue', 'J-cex-spot-04-hl-venue', 'J-derivatives-01-hl-venue', 'J-derivatives-03-hl-venue'];
  const before = { [`${DIR}/J-derivatives-01-hl-venue.json`]: pretty(recording('J-derivatives-01-hl-venue', 26)) };
  const after = Object.fromEntries(names.map((n) => [`${DIR}/${n}.json`, pretty(overNow[n] ?? recording(n, 27))]));
  return repo(before, after);
};

const inputs = async (r, diff) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-review-recordings-in-'));
  const src = {
    diff: async () => ({ diff: r.diff, mergeBase: r.base }),
    read: async () => null,
    journeys: async () => [],
    readGraph: () => null,
  };
  const said = await writeReviewInputs(dir, { diff, base: r.base, head: r.head, pr: 11192, src, loadWords: never, ...briefs });
  const verdict = existsSync(join(dir, 'verdict.json')) ? JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')) : null;
  const prompt = existsSync(join(dir, 'prompt.txt')) ? readFileSync(join(dir, 'prompt.txt'), 'utf8') : '';
  rmSync(dir, { recursive: true });
  return { said, verdict, prompt, skipped: said.startsWith('diff too large') };
};

test("#11192's daily recordings reach the reviewer as their calls, in one call, instead of a FAIL for their size", async () => {
  const r = daily();
  try {
    const bytes = Buffer.byteLength(r.diff);
    assert.ok(bytes > MAX_DIFF_BYTES * MAX_PARTS, `${bytes} bytes: over what ${MAX_PARTS} parts carry, as on #11192`);
    // The job reads the blobs (cmdDiff: exportBlobsNeeded), and the reviewer gets each recording's calls, in one call.
    const out = summarizeGenerated(r.diff, { readBlob: r.readBlob });
    assert.ok(Buffer.byteLength(out) < MAX_DIFF_BYTES, `${Buffer.byteLength(out)} bytes reach the reviewer`);
    const got = await inputs(r, out);
    assert.ok(!got.skipped && got.verdict === null, `the reviewer is asked: ${got.said}`);
    for (const p of ['J-cex-spot-01', 'J-cex-spot-04', 'J-derivatives-01', 'J-derivatives-03'])
      assert.ok(got.prompt.includes(`diff --git a/${DIR}/${p}-hl-venue.json b/${DIR}/${p}-hl-venue.json`), p);
    // Whole, as before this summary, it is a FAIL written without the reviewer: "split the pull request".
    assert.match(splitDiff(r.diff).tooLarge, /parts of 400000 bytes, over 10|over 400000/, 'whole, it cannot be parted');
    const whole = await inputs(r, r.diff);
    assert.ok(whole.skipped && /split the pull request/.test(whole.verdict.findings[0]), 'whole, a FAIL for its size');
    const lines = out.split('\n');
    // What the review reads in a recording: the trader held as <trader>, the addresses asked about, which calls changed.
    assert.ok(lines.includes('+ "trader" "<trader>"'), 'an added file names its trader');
    assert.ok(lines.includes(`# addresses its requests name, with how many times: ${HOUSE} (15)`));
    assert.ok(!lines.some((l) => l.startsWith('!')), 'nothing a recording should never hold');
    assert.ok(
      lines.some((l) =>
        /^- old call 1: \/info 200 testnet \{"type":"spotMeta"\} -> <\d+ bytes of JSON, sha256 [0-9a-f]{16}, an object of 2 key\(s\) \["universe","tokens"\]>$/.test(
          l,
        ),
      ),
    );
    assert.ok(
      lines.some((l) => /^\+ new call 33: \/exchange 200 testnet \{"action":\{"type":"order".* -> \{"status":"ok",.*"oid":74\}/.test(l)),
      'an /exchange answer whole',
    );
    assert.ok(lines.includes('= 30 call(s) the same: old 3-32, new 3-32'), 'the calls kept, as one line');
  } finally {
    r.done();
  }
});

test('planted on the daily diff: a signature, a key, a trader not held, a status change and a call added each show', () => {
  const day = recording('J-derivatives-01-hl-venue', 27, {
    status: 429,
    trader: undefined,
    extra: [
      {
        path: '/exchange',
        request: { action: { type: 'cancel' }, nonce: 1, signature: { r: '0x1', s: '0x2', v: 27 } },
        status: 200,
        answer: { status: 'ok', agentPrivateKey: `0x${'ab'.repeat(32)}` },
        source: 'testnet',
      },
    ],
  });
  delete day.trader;
  const r = daily({ 'J-derivatives-01-hl-venue': day });
  try {
    const lines = summarizeGenerated(r.diff, { readBlob: r.readBlob }).split('\n');
    for (const l of [
      '- "trader" "<trader>"',
      '! the recording holds no trader as "<trader>": its addresses are as they were recorded',
      '! a key named like a signature or a secret: call 34 request."signature"',
      '! a key named like a signature or a secret: call 34 answer."agentPrivateKey"',
      '# strings of 0x and 64 hex, by the key they sit under: "agentPrivateKey" (1)',
    ])
      assert.ok(lines.includes(l), l);
    assert.ok(
      lines.some((l) => l.startsWith('- old call 33: /exchange 200 ')) && lines.some((l) => l.startsWith('+ new call 33: /exchange 429 ')),
      'the status',
    );
    assert.ok(
      lines.some((l) => l.startsWith('+ new call 34: /exchange 200 testnet {"action":{"type":"cancel"},"nonce":1,"signature":')),
      'the call added, whole',
    );
  } finally {
    r.done();
  }
});

test('stays whole: a diff under the cap, a blob not the one named, a recording not in its exact form, and a rename', () => {
  // Under the cap: the reviewer reads the recording's diff as it is.
  const small = repo(
    { [`${DIR}/a.json`]: pretty({ label: 'TEST', note: 'x', calls: [] }) },
    { [`${DIR}/a.json`]: pretty({ label: 'TEST', note: 'y', calls: [] }) },
  );
  try {
    assert.equal(summarizeGenerated(small.diff, { readBlob: small.readBlob }), small.diff);
  } finally {
    small.done();
  }
  const r = daily();
  try {
    const changed = `${DIR}/J-derivatives-01-hl-venue.json`;
    const section = (d) => d.slice(d.indexOf(`diff --git a/${changed}`), d.indexOf('diff --git', d.indexOf(`diff --git a/${changed}`) + 1));
    // Without the blobs, or with a wrong one, the changed file stays whole; the added ones are read from their hunks.
    for (const readBlob of [null, () => 'not the blob', () => assert.fail('throws')]) {
      const out = summarizeGenerated(r.diff, { readBlob });
      assert.ok(out.includes(section(r.diff)), 'the changed file whole');
      assert.ok(out.includes(`diff --git a/${DIR}/J-cex-spot-01-hl-venue.json`) && out.includes('[Hyperliquid venue recording'));
    }
  } finally {
    r.done();
  }
  // A top-level key no recording has, a call with a key of its own, a repeated key: whole, byte for byte.
  const odd = recording('J-cex-spot-01-hl-venue', 27);
  for (const text of [
    pretty({ ...odd, planted: 1 }),
    pretty({ ...odd, calls: [{ ...odd.calls[0], hidden: 'x' }, ...odd.calls.slice(1)] }),
    pretty(odd).replace('"label": "TEST",', '"label": "TEST",\n  "note": "hidden",'),
  ]) {
    const x = repo({}, { [`${DIR}/J-cex-spot-01-hl-venue.json`]: text });
    try {
      assert.equal(summarizeGenerated(x.diff, { readBlob: x.readBlob }), x.diff);
    } finally {
      x.done();
    }
  }
  // A recording moved to another path stays whole.
  const big = pretty(recording('J-cex-spot-01-hl-venue', 27));
  // In a diff over the cap, beside the daily one, so only its being a rename keeps it whole.
  const r2 = daily();
  const moved = repo(
    { [`${DIR}/one.json`]: big },
    { [`${DIR}/one.json`]: null, [`${DIR}/two.json`]: big.replace('"note": "', '"note": "moved ') },
  );
  try {
    assert.match(moved.diff, /^rename from /m, 'git names it a rename');
    assert.equal(summarizeGenerated(moved.diff + r2.diff, { readBlob: r2.readBlob }).slice(0, moved.diff.length), moved.diff);
  } finally {
    moved.done();
    r2.done();
  }
});

test("the test part judges the compare diff the review read, and never downloads it a second time (#11192's closed read)", async () => {
  const origin = daily();
  const clone = mkdtempSync(join(tmpdir(), 'ci-review-recordings-clone-'));
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    asked.push(path);
    if (path.endsWith('?per_page=1')) return new Response(JSON.stringify({ merge_base_commit: { sha: origin.base } }), { status: 200 });
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
  };
  try {
    execFileSync('git', ['clone', '-q', '--no-checkout', origin.root, clone]);
    const src = ciSource('INTAFACED/intafaced', 'token', clone, { base: origin.base, head: origin.head, diff: origin.diff });
    const got = await src.diff(origin.base, origin.head);
    assert.equal(got.diff, origin.diff, 'the diff the review read, byte for byte');
    assert.equal(got.mergeBase, origin.base);
    assert.deepEqual(asked, [`/repos/INTAFACED/intafaced/compare/${origin.base}...${origin.head}?per_page=1`], 'one small read, no diff');
    // Another base or head is read as before, and its failed read still fails.
    const other = ciSource('INTAFACED/intafaced', 'token', clone, { base: origin.head, head: origin.head, diff: 'stale' });
    await assert.rejects(other.diff(origin.base, origin.head), /fetch failed|other side closed/);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(clone, { recursive: true });
    origin.done();
  }
});
