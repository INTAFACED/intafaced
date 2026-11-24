// The look gate's pictures for the CI review (#9325), offline: when the review waits for CI's look job, which pictures
// it trusts, the band it cuts from each, which views it shows within its budget, and how they reach the reviewer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, encodePng } from './look-gate/png.mjs';
import { changedBand, changedRows, lookImages, lookState, pickViews, reachedViews, VIEWPORTS } from './look-pictures.mjs';
import { diffPaths, streamInput } from './ci-review.mjs';
import { reachesLook } from './ci-affected.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'e'.repeat(40);

/** A solid picture, with rows [from, to) painted another colour. */
function picture(width, height, paint = null, rgb = [200, 40, 40]) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const on = paint && y >= paint[0] && y < paint[1];
      data.set(on ? [...rgb, 255] : [12, 12, 12, 255], (y * width + x) * 4);
    }
  return encodePng({ width, height, data });
}

const shard = (k, status = 'completed') => ({ name: `Look / Look gate on the rooms it changes (${k}/3)`, status });

test('the wait: for a CI run, then for every look gate shard; none when the Look job is skipped or never ran', () => {
  const jobsOf = (jobs) => () => jobs;
  assert.equal(lookState({ runs: [], jobsOf: jobsOf([]) }).state, 'wait');
  assert.equal(lookState({ runs: [{ id: 1, status: 'in_progress' }], jobsOf: jobsOf([{ name: 'Changes' }]) }).state, 'wait');
  const skipped = lookState({ runs: [{ id: 1, status: 'in_progress' }], jobsOf: jobsOf([{ name: 'Look', conclusion: 'skipped' }]) });
  assert.equal(skipped.state, 'none');
  assert.match(skipped.why, /skipped/);
  assert.equal(lookState({ runs: [{ id: 1, status: 'completed' }], jobsOf: jobsOf([{ name: 'Build' }]) }).state, 'none');
  const two = lookState({ runs: [{ id: 1, status: 'in_progress' }], jobsOf: jobsOf([shard(1), shard(2, 'in_progress'), shard(3)]) });
  assert.equal(two.state, 'wait');
  assert.match(two.why, /2 of 3/);
  // A shard not listed yet is waited for too.
  assert.equal(lookState({ runs: [{ id: 1, status: 'in_progress' }], jobsOf: jobsOf([shard(1), shard(2)]) }).state, 'wait');
  const ready = lookState({
    runs: [{ id: 1 }, { id: 7, status: 'in_progress' }],
    jobsOf: (r) => (r.id === 7 ? [shard(1), shard(2), shard(3)] : []),
  });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.run.id, 7, 'the newest run counts');
});

test('the review waits only for a change CI runs the look gate for', () => {
  const diff = (p) => `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.deepEqual(diffPaths(diff('apps/customer/src/x.tsx')), ['apps/customer/src/x.tsx', 'apps/customer/src/x.tsx']);
  assert.equal(reachesLook(diffPaths(diff('apps/customer/src/screens/pay/index.tsx'))), true);
  assert.equal(reachesLook(diffPaths(diff('packages/ui/src/lit/lit.css'))), true);
  assert.equal(reachesLook(diffPaths(diff('services/svc-bank/src/index.ts'))), false);
});

test('the band: one screen high, the same rows of both sides, starting a little above the first change', () => {
  const vp = VIEWPORTS.computer;
  const before = picture(40, 3000);
  const after = picture(40, 3000, [1500, 1520]);
  assert.deepEqual(changedRows(decodePng(before), decodePng(after)), { first: 1500, last: 1519 });
  const band = changedBand(before, after, vp);
  assert.equal(band.box.height, vp.height);
  assert.equal(band.box.y, 1500 - Math.round(vp.height * 0.15));
  const b = decodePng(band.after);
  assert.equal(b.width, 40);
  assert.equal(b.height, vp.height);
  // The changed rows are inside the band, painted on the after side only.
  const row = (img, y) => Array.from(img.data.subarray(y * img.width * 4, y * img.width * 4 + 4));
  assert.deepEqual(row(b, 1500 - band.box.y), [200, 40, 40, 255]);
  assert.deepEqual(row(decodePng(band.before), 1500 - band.box.y), [12, 12, 12, 255]);
  // Identical pictures give no band.
  assert.equal(changedBand(before, picture(40, 3000), vp), null);
  // A change at the very bottom keeps the band inside the page.
  const low = changedBand(before, picture(40, 3000, [2990, 3000]), vp);
  assert.equal(low.box.y, 3000 - vp.height);
  // A page shorter than a screen is shown whole.
  assert.equal(changedBand(picture(40, 300), picture(40, 300, [10, 20]), vp).box.height, 300);
});

test('a page that grew: the change starts where the shared rows end, and the shorter side is padded', () => {
  const vp = VIEWPORTS.phone;
  const band = changedBand(picture(20, 2000), picture(20, 2400), vp);
  assert.equal(band.box.first, 2000);
  assert.equal(band.box.last, 2399);
  assert.equal(decodePng(band.before).height, vp.height);
  assert.equal(decodePng(band.after).height, vp.height);
});

function artifact({ link = false, badPath = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'look-pictures-'));
  const art = join(dir, 'look-pr-1');
  const rooms = [
    ['/pay', 'pay'],
    ['/home', 'home'],
  ];
  for (const [, room] of rooms) {
    mkdirSync(join(art, 'pictures', room), { recursive: true });
    for (const vp of ['phone', 'computer']) {
      writeFileSync(join(art, 'pictures', room, `${vp}.before.png`), picture(30, 1200));
      writeFileSync(join(art, 'pictures', room, `${vp}.after.png`), picture(30, 1200, [400, 420]));
    }
  }
  if (link) symlinkSync('/etc/hostname', join(art, 'pictures', 'pay', 'stolen.png'));
  const views = (room) =>
    ['phone', 'computer'].map((vp) => ({
      viewport: vp,
      before: badPath && room === 'pay' && vp === 'computer' ? '../../../etc/passwd' : `pictures/${room}/${vp}.before.png`,
      after: link && room === 'pay' && vp === 'computer' ? 'pictures/pay/stolen.png' : `pictures/${room}/${vp}.after.png`,
    }));
  writeFileSync(
    join(art, 'pictures-1-of-3.json'),
    JSON.stringify({ shard: [1, 3], rooms: 2, reached: rooms.map(([route, room]) => ({ route, room, views: views(room) })) }),
  );
  return dir;
}

test('the manifest: only its own plain PNG files, never a link or a path that climbs out', () => {
  const ok = reachedViews(artifact());
  assert.equal(ok.length, 4);
  assert.ok(ok.every((v) => v.before && v.after));
  const linked = reachedViews(artifact({ link: true })).find((v) => v.route === '/pay' && v.viewport === 'computer');
  assert.equal(linked.after, null);
  const climbed = reachedViews(artifact({ badPath: true })).find((v) => v.route === '/pay' && v.viewport === 'computer');
  assert.equal(climbed.before, null);
});

test('the picks: every room once at computer before any room twice', () => {
  const views = ['/a', '/b', '/c'].flatMap((route) => ['phone', 'computer'].map((viewport) => ({ route, viewport })));
  assert.deepEqual(
    pickViews(views, 4).map((v) => `${v.route} ${v.viewport}`),
    ['/a computer', '/b computer', '/c computer', '/a phone'],
  );
  assert.equal(pickViews(views, 0).length, 0);
});

test('the images: a note naming every reached room, then a before and an after band per shown view, within the budget', () => {
  const dir = artifact();
  const all = lookImages(dir, { head: HEAD, base: BASE, maxImages: 20, maxBytes: 20_000_000 });
  assert.equal(all.images[0].data, undefined);
  assert.match(all.images[0].text, /2 room\(s\) differ: \/home, \/pay/);
  assert.equal(all.images.length, 1 + 8);
  assert.match(all.images[1].label, /^Look picture: \/home at computer 1440 px wide, before this pull request, at base eeeeeee/);
  assert.match(all.images[2].label, /after this pull request, at head aaaaaaa/);
  assert.match(all.images[1].label, /untrusted data like the diff/);
  // Room for two views only: the computer views, and the rest named as not shown.
  const two = lookImages(dir, { head: HEAD, base: BASE, maxImages: 4, maxBytes: 20_000_000 });
  assert.equal(two.images.length, 1 + 4);
  assert.match(two.images[0].text, /Not shown: .*\/home \(phone\): past the 2 views/);
  // Past the bytes, nothing is attached but each view is named.
  const none = lookImages(dir, { head: HEAD, base: BASE, maxImages: 20, maxBytes: 10 });
  assert.equal(none.images.length, 0);
  assert.match(none.note, /past the call's image bytes/);
  // No manifest, no images.
  assert.deepEqual(
    lookImages(mkdtempSync(join(tmpdir(), 'look-none-')), { head: HEAD, base: BASE, maxImages: 20, maxBytes: 1e7 }).images,
    [],
  );
});

test('the stream input carries the note as text and numbers only the pictures', () => {
  const { images } = lookImages(artifact(), { head: HEAD, base: BASE, maxImages: 4, maxBytes: 20_000_000 });
  const c = JSON.parse(streamInput('THE PROMPT', images)).message.content;
  assert.deepEqual(
    c.map((b) => b.type),
    ['text', 'text', 'text', 'image', 'text', 'image', 'text', 'image', 'text', 'image', 'text'],
  );
  assert.match(c[1].text, /^LOOK PICTURES/);
  assert.match(c[2].text, /^Image 1 of 4: Look picture: \/home at computer/);
  assert.match(c[8].text, /^Image 4 of 4: /);
});
