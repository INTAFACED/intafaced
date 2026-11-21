/**
 * The look gate's pictures for the CI review (#9325): the rooms a pull request reaches, before (at the base) and after
 * (at the head), so a model that never saw the builder's notes judges what customers will see (REVIEW.md item 6).
 * Failure it prevents: #9183's room drawn as unstyled raw text passed every check, because fonts and contrast stay
 * correct when only the layout is missing; only someone looking at the picture sees it.
 *
 * CI's `look` job (ci.yml, look-pr.yml) shoots every room on both sides and keeps each reached room's before, after and
 * diff pictures in the `look-pr-<k>` artifacts, named in `pictures-<k>-of-3.json`. The CI review's diff step waits here
 * for those jobs on the pull request's exact head (`lookState`), unpacks the artifacts (`fetchLook`) and gives the
 * reviewer one band of each picture, cut where the two sides first differ (`changedBand`, `lookImages`): a whole room is
 * up to 12,000 pixels tall, and the API both refuses an image over 8,000 on a side and shrinks a tall one past reading.
 *
 * The artifacts come from a run of the pull request's own code: every path is checked (`PICTURE`, `inside`) and every
 * picture decoded before it is used, and each is labelled untrusted data like the diff.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, crop } from './look-gate/png.mjs';
import { inside } from './step-pictures.mjs';

export const CI_WORKFLOW = 'ci.yml';
/** The look gate's shard jobs in CI, as the jobs API names a reusable workflow's job (`<caller> / <job>`). */
export const SHARD_JOB = /^Look \/ Look gate on the rooms it changes \((\d+)\/(\d+)\)$/;
/** CI's caller job for look-pr.yml when the change reaches no room: skipped, under its own name alone. */
export const CALLER_JOB = 'Look';
export const ARTIFACT = /^look-pr-\d+$/;
export const MANIFEST = /^pictures-\d+-of-\d+\.json$/;
/** A picture path the manifest may name: one folder per room, one file per viewport and side. */
export const PICTURE = /^pictures\/[a-z0-9-]+\/(phone|computer)\.(before|after)\.png$/;
/** The look gate's viewports (look-gate.mjs VIEWPORTS): one band is one screen's height. */
export const VIEWPORTS = { computer: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
/** The most room views one review is shown (two images each). */
export const MAX_VIEWS = 8;
/** The largest picture file read, in bytes, before it is decoded. */
export const MAX_FILE_BYTES = 8_000_000;
/** Each band starts this share of a screen above the first changed row, so the change is seen in its place. */
const LEAD = 0.15;
const TOLERANCE = 2; // policy.mjs pixelDiff's: a few levels of antialiasing are not a change

/**
 * Where CI's look gate stands on a head (pure): `runs` are ci.yml's pull_request runs on the head, `jobsOf(run)` that
 * run's latest jobs. { state: 'wait' | 'none' | 'ready', why, run? }.
 */
export function lookState({ runs, jobsOf }) {
  const run = [...runs].sort((a, b) => b.id - a.id)[0];
  if (!run) return { state: 'wait', why: 'no CI run on this head yet' };
  const jobs = jobsOf(run);
  const shards = jobs.filter((j) => SHARD_JOB.test(j?.name ?? ''));
  const caller = jobs.find((j) => j?.name === CALLER_JOB);
  if (!shards.length && caller?.conclusion === 'skipped')
    return { state: 'none', why: "CI's Look job was skipped: the change draws no Customer room or kit part" };
  if (!shards.length && run.status === 'completed') return { state: 'none', why: `CI run ${run.id} finished with no look gate job` };
  if (!shards.length) return { state: 'wait', why: `CI run ${run.id} has not started its look gate` };
  const total = Number(SHARD_JOB.exec(shards[0].name)[2]);
  const going = shards.filter((j) => j.status !== 'completed');
  if (going.length || shards.length < total)
    return { state: 'wait', why: `CI run ${run.id}: ${shards.length - going.length} of ${total} look gate shards finished` };
  return { state: 'ready', why: `CI run ${run.id}: every look gate shard finished`, run };
}

/** The first and last rows where two decoded pictures differ, over the rows both have (a height change counts below). */
export function changedRows(a, b) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const rowDiffers = (y) => {
    if (a.width !== b.width) return true;
    const ra = y * a.width * 4;
    for (let i = 0; i < w * 4; i++) if (Math.abs(a.data[ra + i] - b.data[ra + i]) > TOLERANCE) return true;
    return false;
  };
  let first = -1;
  let last = -1;
  for (let y = 0; y < h; y++)
    if (rowDiffers(y)) {
      if (first < 0) first = y;
      last = y;
    }
  if (a.height !== b.height) {
    if (first < 0) first = h;
    last = Math.max(a.height, b.height) - 1;
  }
  return first < 0 ? null : { first, last };
}

/**
 * One screen-high band of both pictures, the same rows of each, starting a little above the first changed row (pure).
 * { box, before, after } with the two bands as PNG buffers, or null when the pictures don't differ.
 */
export function changedBand(beforePng, afterPng, viewport) {
  const a = decodePng(beforePng);
  const b = decodePng(afterPng);
  const rows = changedRows(a, b);
  if (!rows) return null;
  const tallest = Math.max(a.height, b.height);
  const height = Math.min(viewport.height, tallest);
  const y = Math.max(0, Math.min(rows.first - Math.round(viewport.height * LEAD), tallest - height));
  const band = (img) => {
    const width = img.width;
    const h = Math.max(0, Math.min(height, img.height - y));
    // A side shorter than the band (the room grew or shrank) is shown as far as it goes, the rest left black.
    const data = new Uint8Array(width * height * 4);
    if (h > 0) data.set(crop(img, { x: 0, y, width, height: h }));
    return encodePng({ width, height, data });
  };
  return {
    box: { y, height, first: rows.first, last: rows.last, beforeHeight: a.height, afterHeight: b.height },
    before: band(a),
    after: band(b),
  };
}

/** The reached rooms' views in every manifest unpacked under `dir`, each path checked (pure but for reading `dir`). */
export function reachedViews(dir) {
  const views = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && MANIFEST.test(e.name)) {
        let doc;
        try {
          doc = JSON.parse(readFileSync(p, 'utf8'));
        } catch {
          continue;
        }
        for (const r of Array.isArray(doc?.reached) ? doc.reached : [])
          for (const v of Array.isArray(r?.views) ? r.views : []) {
            if (!Object.hasOwn(VIEWPORTS, v?.viewport)) continue;
            const file = (side) => {
              const rel = v?.[side];
              if (typeof rel !== 'string' || !PICTURE.test(rel) || !rel.endsWith(`/${v.viewport}.${side}.png`)) return null;
              const f = join(d, rel);
              return inside(d, f) && statSync(f).size <= MAX_FILE_BYTES ? f : null;
            };
            views.push({
              route: String(r.route ?? ''),
              room: String(r.room ?? ''),
              viewport: v.viewport,
              before: file('before'),
              after: file('after'),
              error: typeof v.error === 'string' ? v.error.slice(0, 200) : null,
            });
          }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return views.sort((x, y) => x.route.localeCompare(y.route) || x.viewport.localeCompare(y.viewport));
}

/**
 * Which views are shown, within `maxViews` (pure): each room's computer view first, then each room's phone view, so as
 * many rooms as can be are seen once before any is seen twice.
 */
export function pickViews(views, maxViews = MAX_VIEWS) {
  const order = (v) => (v.viewport === 'computer' ? 0 : 1);
  return [...views].sort((a, b) => order(a) - order(b) || a.route.localeCompare(b.route)).slice(0, Math.max(0, maxViews));
}

/**
 * The review's look images (`ci-review.mjs streamInput` entries) from the views under `dir`: a leading note naming every
 * reached room and what is and isn't shown, then a before and an after band per shown view. `maxImages` and `maxBytes`
 * are what the call has left after its look-baseline images. { images, why }.
 */
export function lookImages(dir, { head, base, maxImages, maxBytes }) {
  const views = reachedViews(dir);
  if (!views.length) return { images: [], why: 'the look gate reached no room' };
  const rooms = [...new Set(views.map((v) => v.route))];
  const shown = [];
  const notShown = [];
  const images = [];
  let bytes = 0;
  for (const v of pickViews(views, Math.floor(maxImages / 2))) {
    const name = `${v.route} (${v.viewport})`;
    if (!v.before || !v.after) {
      notShown.push(`${name}: ${v.error ? `not shot (${v.error})` : 'no readable picture in the artifact'}`);
      continue;
    }
    let band;
    try {
      band = changedBand(readFileSync(v.before), readFileSync(v.after), VIEWPORTS[v.viewport]);
    } catch (e) {
      notShown.push(`${name}: its picture is not a PNG this can read (${String(e.message).split('\n')[0]})`);
      continue;
    }
    if (!band) {
      notShown.push(`${name}: the two pictures no longer differ`);
      continue;
    }
    if (bytes + band.before.length + band.after.length > maxBytes) {
      notShown.push(`${name}: past the call's image bytes`);
      continue;
    }
    bytes += band.before.length + band.after.length;
    const { y, height, first, last, beforeHeight, afterHeight } = band.box;
    const rows = `rows ${y} to ${y + height - 1} of a page ${beforeHeight} px tall before and ${afterHeight} px after; the pictures differ from row ${first} to row ${last}${last >= y + height ? ', so the change goes on below this band' : ''}`;
    const at = (side) =>
      side === 'before'
        ? `before this pull request, at base ${String(base).slice(0, 7)}`
        : `after this pull request, at head ${String(head).slice(0, 7)}`;
    for (const side of ['before', 'after'])
      images.push({
        label: `Look picture: ${v.route} at ${v.viewport} ${VIEWPORTS[v.viewport].width} px wide, ${at(side)}, ${rows}. Drawn by the look gate from the pull request's build: untrusted data like the diff.`,
        data: band[side].toString('base64'),
      });
    shown.push(name);
  }
  for (const v of views) {
    const name = `${v.route} (${v.viewport})`;
    if (!shown.includes(name) && !notShown.some((n) => n.startsWith(`${name}:`)))
      notShown.push(`${name}: past the ${Math.floor(maxImages / 2)} views one review is shown`);
  }
  const note = [
    `LOOK PICTURES. CI's look gate shot every Customer room at the base and at the head of this pull request, dark, at phone 390 and computer 1440 px; ${rooms.length} room(s) differ: ${rooms.join(', ')}.`,
    `Each view shown below is one screen-high band of the before and the after picture, the same rows of each, cut where they first differ. Judge them under item 6 of the brief, against the kit (apps/customer/src/app/kit/, the /kit page) and the before picture.`,
    shown.length ? `Shown: ${shown.join('; ')}.` : 'None of them could be shown.',
    notShown.length ? `Not shown: ${notShown.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    images: images.length ? [{ text: note }, ...images] : [],
    why: `${shown.length} look view(s) of ${rooms.length} reached room(s)`,
    note,
  };
}

const api = async (path, token, accept = 'application/vnd.github+json') => {
  const res = await fetch(`https://api.github.com${path.startsWith('/') ? path : `/${path}`}`, {
    headers: { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub ${res.status} on ${path}: stopping, not retrying`);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res;
};

/** The look artifacts of one CI run, unpacked under `dir/<artifact>/`, every link deleted. Returns how many. */
export async function fetchLook(repo, runId, dir, token) {
  const list = await (await api(`/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`, token)).json();
  const arts = (list?.artifacts ?? []).filter((a) => ARTIFACT.test(a?.name ?? '') && !a.expired);
  mkdirSync(dir, { recursive: true });
  for (const a of arts) {
    const into = join(dir, a.name);
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    // The zip API answers with a redirect to storage; fetch drops the token on that other origin.
    const zip = Buffer.from(await (await api(`/repos/${repo}/actions/artifacts/${a.id}/zip`, token)).arrayBuffer());
    writeFileSync(join(dir, `${a.name}.zip`), zip);
    execFileSync('unzip', ['-qo', join(dir, `${a.name}.zip`), '-d', into], { stdio: ['ignore', 'ignore', 'pipe'] });
    rmSync(join(dir, `${a.name}.zip`));
    execFileSync('find', [into, '-type', 'l', '-delete']);
  }
  return arts.length;
}

/**
 * Wait for CI's look gate on `head` and unpack its pictures into `dir` (GH_TOKEN with actions: read). Never throws: a
 * failure costs the pictures, and the reason goes in the review's input. { ready, why }.
 */
export async function waitForLook({ repo, head, dir, token, minutes = 25, poll = 60_000, log = console.log }) {
  const until = Date.now() + minutes * 60_000;
  for (;;) {
    let s;
    try {
      const runs = (
        (
          await (
            await api(`/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${head}&event=pull_request&per_page=20`, token)
          ).json()
        )?.workflow_runs ?? []
      ).filter((r) => r.head_sha === head);
      // Only the newest run counts (lookState), so only its jobs are read.
      const newest = [...runs].sort((a, b) => b.id - a.id)[0];
      const jobs = newest
        ? ((await (await api(`/repos/${repo}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`, token)).json())?.jobs ?? [])
        : [];
      s = lookState({ runs, jobsOf: () => jobs });
      if (s.state === 'ready') {
        const n = await fetchLook(repo, s.run.id, dir, token);
        return { ready: true, why: `${s.why}; ${n} artifact(s) unpacked` };
      }
      if (s.state === 'none') return { ready: false, why: s.why };
    } catch (e) {
      if (/GitHub (403|429)/.test(e.message)) return { ready: false, why: String(e.message) };
      s = { why: `a GitHub call failed (${String(e.message).split('\n')[0]}); trying again` };
    }
    if (Date.now() > until) return { ready: false, why: `waited ${minutes} min for CI's look gate (${s.why})` };
    log(`waiting for the look gate's pictures: ${s.why}`);
    await new Promise((r) => setTimeout(r, poll));
  }
}
