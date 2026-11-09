/**
 * What a journey reached, recorded while it runs (apps/customer/tests/real-app/journey.mjs), so a later map can say which
 * journeys a product change can break from evidence, not a guess (project-state STATE.md, the binding constraint: every
 * pull request runs the whole suite because nothing says which journeys its code reaches). This file only records; the
 * map and its use in the merge seal are separate changes.
 *
 * The record goes into the Playwright report, which a public repository's run uploads for anyone to read. So it holds
 * only values from fixed lists or of a fixed shape, never text a request, a log or a page supplied: an allow-list, since
 * a deny-list fails open. One record per test, attached as `journey-reach` (application/json), holding only what this
 * worker had not attached for the same journey file yet:
 *   - http: `<port> <METHOD>` for each request a journey's Node code or its pages sent to the stack (loopback), with
 *     ` <route>` added when the path is under one of Edge's own route prefixes (`/api/bank`; routeTable, read from
 *     services/svc-edge/src/routes.ts): a port names a stack service, a prefix an Edge route. Nothing else of the URL;
 *   - served: `<service>` for each service whose own log (`<state>/logs/<service>.log`, Fastify's `incoming request`
 *     lines at the stack's LOG_LEVEL info) shows it served a request while the file ran, with ` <route>` on the same
 *     terms; so a call from one service to another counts. A line goes to the journey file running at the line's own
 *     time, so a write that lands late still counts for the right file. Background work (the TEST market maker,
 *     pollers) counts for whichever file runs: more reach, never less;
 *   - active: the services that logged anything at all while the file ran (an event handler that serves no request);
 *   - chunks: the customer app's built scripts that loaded (`/assets/index-1a2b.js`; built file names only);
 *   - sources: for each repository source file of the customer app (and the packages it bundles), the line ranges of the
 *     functions that ran, from Chromium's precise coverage, placed through the build's reduced position maps;
 *   - table: the first time this worker sees a chunk, the repository source paths its map lists;
 *   - nomap: the first time this worker sees one, a built script that ran and has no position map (the boot script, the
 *     bundler's runtime, vendor code). Its sources are in no table, so the map reads them as unmapped: full;
 *   - afterAll: true on the record that carries a file's afterAll hooks' reach (attached by the next file's first test);
 *     afterAllDue: true on the other records of a file that declares afterAll hooks, so the map can tell when that
 *     record never came (a worker's last file has no next test): it reads such a file as incomplete;
 *   - incomplete: reason codes (INCOMPLETE) for what this record can't see whole. The map treats an incomplete journey
 *     as reaching every source.
 *
 * The position maps: the stack's customer build writes Vite's hidden source maps, and reduceMaps turns each into
 * `<script>.positions.json` (repository source paths and generated-to-source line positions, no source text) and deletes
 * the `.map`, before anything packs or serves the build. No `.map` file and no source content leaves the build step.
 * Recording never changes a request or a page, and never fails a test.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const REACH_ATTACHMENT = 'journey-reach';
export const REACH_VERSION = 2;
export const POSITIONS_SUFFIX = '.positions.json';

/** The only reasons a record may give for being incomplete. */
export const INCOMPLETE = {
  popup: 'the app opened a page by itself; its first scripts ran before coverage started',
  closed: 'a page closed before its coverage was read',
  detached: 'a page lost its coverage session before it was read',
  noStart: 'coverage could not start on a page',
  noRead: "a page's coverage could not be read",
  notBuilt: 'a customer script ran that the build on disk does not hold',
  otherBuild: 'a customer script ran whose length differs from the build on disk (another build served)',
  badMap: "a customer script's position map could not be read",
  otherDist: 'the stack serves the customer app from another folder (a customer-dist override), not the build on disk here',
};

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'WS']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SERVICE = /^[a-z][a-z0-9-]{0,39}$/;
const BUILT_SCRIPT = /^\/assets\/[A-Za-z0-9._-]{1,120}\.js$/;
const REPO_SOURCE = /^(apps|packages|services)\/[A-Za-z0-9._@/-]{1,300}$/;

/** Edge's route prefixes (`/api/bank`), read from its route table: the only path text a record may hold. */
export function routeTable(root) {
  try {
    const text = readFileSync(path.join(root, 'services/svc-edge/src/routes.ts'), 'utf8');
    return [...new Set([...text.matchAll(/prefix:\s*'(\/api\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)'/g)].map((m) => m[1]))].sort(
      (a, b) => b.length - a.length,
    );
  } catch {
    return [];
  }
}

/** The longest route prefix a path is under, or null. */
export const routeOf = (routes, pathname) => {
  const p = String(pathname ?? '');
  return routes.find((r) => p === r || p.startsWith(`${r}/`)) ?? null;
};

const method = (m) => {
  const u = String(m ?? 'GET').toUpperCase();
  return METHODS.has(u) ? u : 'OTHER';
};

/** `<port> <METHOD>[ <route>]` for a URL on the stack (loopback), or null for anything else. */
export function requestKey(routes, url, m = 'GET') {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (!/^(https?|wss?):$/.test(u.protocol) || !LOOPBACK.has(u.hostname)) return null;
  const port = u.port || (/^(https|wss):$/.test(u.protocol) ? '443' : '80');
  if (!/^\d{1,5}$/.test(port)) return null;
  const r = routeOf(routes, u.pathname);
  return `${port} ${/^wss?:$/.test(u.protocol) ? 'WS' : method(m)}${r ? ` ${r}` : ''}`;
}

// ---- Source maps, reduced to positions ----

const B64_VAL = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));

/** A source map's `mappings`, decoded: per generated line, [genCol, srcIndex, srcLine (0-based)] sorted by genCol. */
export function decodeMappings(mappings) {
  const lines = [];
  let src = 0;
  let srcLine = 0;
  for (const lineText of String(mappings ?? '').split(';')) {
    const segs = [];
    let genCol = 0;
    for (const seg of lineText.split(',')) {
      if (!seg) continue;
      const vals = [];
      let shift = 0;
      let value = 0;
      for (const c of seg) {
        const d = B64_VAL.get(c);
        if (d === undefined) throw new Error('bad base64 VLQ digit');
        value += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
          shift = 0;
          value = 0;
        }
      }
      genCol += vals[0];
      if (vals.length >= 4) {
        src += vals[1];
        srcLine += vals[2];
        segs.push([genCol, src, srcLine]);
      }
    }
    segs.sort((a, b) => a[0] - b[0]);
    lines.push(segs);
  }
  return lines;
}

/** A map `sources` entry as the repository path it names (`apps/customer/src/x.tsx`), or null (a dependency, outside). */
export function repoSource(root, mapFile, source, sourceRoot = '') {
  const abs = path.resolve(path.dirname(mapFile), sourceRoot || '', String(source).replace(/^[a-z]+:\/\/\/?/i, ''));
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split('/').includes('node_modules') || !REPO_SOURCE.test(rel)) return null;
  return rel;
}

/**
 * Every `.map` under a build folder is deleted; each `<script>.js.map` first becomes `<script>.js.positions.json`:
 * { v: 1, sources: [repository path or null], lines: [[[genCol, srcIndex, srcLine]]] }, positions only, no source text
 * and no names. A map that can't be read is deleted all the same (its script then has no positions: nomap). Returns
 * { reduced, dropped }. The stack's customer build runs it straight after `vite build`.
 */
export function reduceMaps(root, distDir) {
  let reduced = 0;
  let dropped = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.map')) {
        try {
          if (!e.name.endsWith('.js.map')) throw new Error('not a script map');
          const map = JSON.parse(readFileSync(full, 'utf8'));
          const out = {
            v: 1,
            sources: (map.sources ?? []).map((s) => repoSource(root, full, s, map.sourceRoot)),
            lines: decodeMappings(map.mappings),
          };
          writeFileSync(full.replace(/\.map$/, POSITIONS_SUFFIX), JSON.stringify(out));
          reduced++;
        } catch {
          dropped++;
        } finally {
          rmSync(full, { force: true });
        }
      }
    }
  };
  if (existsSync(distDir)) walk(distDir);
  return { reduced, dropped };
}

/** One built script's text and positions, read from the build on disk: { text, starts, lines, sources }, { noMap },
 *  or { error: <INCOMPLETE code> }. */
export function loadScript({ distDir, scriptPath }) {
  if (!BUILT_SCRIPT.test(scriptPath)) return { error: 'notBuilt' };
  const file = path.join(distDir, scriptPath.replace(/^\/+/, ''));
  if (!path.resolve(file).startsWith(path.resolve(distDir) + path.sep) || !existsSync(file)) return { error: 'notBuilt' };
  const posFile = `${file}${POSITIONS_SUFFIX}`;
  if (!existsSync(posFile)) return { noMap: true };
  try {
    const text = readFileSync(file, 'utf8');
    const pos = JSON.parse(readFileSync(posFile, 'utf8'));
    if (pos.v !== 1 || !Array.isArray(pos.lines) || !Array.isArray(pos.sources)) throw new Error('shape');
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const sources = pos.sources.map((s) => (typeof s === 'string' && REPO_SOURCE.test(s) ? s : null));
    return { text, starts, lines: pos.lines, sources };
  } catch {
    return { error: 'badMap' };
  }
}

/** The generated line (0-based) an offset is on. */
const lineOf = (script, offset) => {
  let lo = 0;
  let hi = script.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (script.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** The index of the last segment at or before `col` on a generated line, or -1. */
const segAt = (segs, col) => {
  let lo = -1;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid][0] <= col) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** The source and line (1-based) a generated offset maps to, or null. */
export function originalAt(script, offset) {
  const line = lineOf(script, offset);
  const segs = script.lines[line] ?? [];
  const i = segAt(segs, offset - script.starts[line]);
  if (i < 0) return null;
  const source = script.sources[segs[i][1]];
  return source ? { source, line: segs[i][2] + 1 } : null;
}

/**
 * Every repository source line a generated span [start, end) maps to, as { [source]: [firstLine, lastLine] } (1-based):
 * the segment covering `start` and every segment that begins inside the span. A function the bundler joined from
 * several modules (scope hoisting) counts in each, and a function that starts before its line's first segment still
 * counts by the segments inside it; a span no segment maps (bundler code) counts in none.
 */
export function spanSources(script, start, end) {
  const out = {};
  const note = (seg) => {
    const source = script.sources[seg[1]];
    if (!source) return;
    const l = seg[2] + 1;
    const r = out[source];
    if (!r) out[source] = [l, l];
    else {
      if (l < r[0]) r[0] = l;
      if (l > r[1]) r[1] = l;
    }
  };
  const last = Math.max(start, end - 1);
  const first = lineOf(script, start);
  const final = lineOf(script, last);
  for (let g = first; g <= final; g++) {
    const segs = script.lines[g] ?? [];
    const to = g === final ? last - script.starts[g] : Infinity;
    let i = g === first ? Math.max(0, segAt(segs, start - script.starts[g])) : 0;
    for (; i < segs.length && segs[i][0] <= to; i++) note(segs[i]);
  }
  return out;
}

/**
 * The functions that ran in one script's coverage (CDP Profiler.takePreciseCoverage `functions`, with call counts), as
 * line ranges per source: { sources: { [source]: [[startLine, endLine]] }, loaded }. A function counts whole, in every
 * source its span maps to (spanSources), so a function that ran is never cut short; functions nested in it that did not
 * run count with it (more reach, never less). The script's own top level (the unnamed function at offset 0) means the
 * chunk loaded; it is `loaded`, not a range.
 */
export function executedRanges(script, functions) {
  const out = {};
  let loaded = false;
  for (const f of functions ?? []) {
    const r = f.ranges?.[0];
    if (!r || !(r.count > 0)) continue;
    if (r.startOffset === 0 && !f.functionName) {
      loaded = true;
      continue;
    }
    for (const [source, range] of Object.entries(spanSources(script, r.startOffset, r.endOffset))) (out[source] ??= []).push(range);
  }
  return { sources: out, loaded };
}

/** Line ranges, sorted and merged where they overlap or touch. */
export function mergeRanges(ranges) {
  const s = [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of s) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// ---- The stack's own logs ----

/**
 * A reader of the stack's service logs that returns, on each read, the lines written since the last one, reduced to
 * { service, time (ms, or null), served (true on an `incoming request` line), method, path }. `method` and `path` stay
 * in this worker's memory: the recorder only compares them with fixed lists (METHODS, the route table) and never
 * stores them. It starts at the logs' current ends, so the stack's start is nobody's. A log that shrank (a restart that
 * truncated it) is read again from its start. A partial last line waits for the next read. A log whose name is not a
 * service's shape is passed over.
 */
export function makeLogReader(logsDir) {
  const at = new Map();
  const rest = new Map();
  const list = () => {
    try {
      return readdirSync(logsDir).filter((f) => f.endsWith('.log') && SERVICE.test(f.slice(0, -4)));
    } catch {
      return [];
    }
  };
  for (const f of list()) {
    try {
      at.set(f, statSync(path.join(logsDir, f)).size);
    } catch {
      /* gone */
    }
  }
  return {
    read() {
      const out = [];
      for (const f of list()) {
        const file = path.join(logsDir, f);
        let size;
        try {
          size = statSync(file).size;
        } catch {
          continue;
        }
        let from = at.get(f) ?? 0;
        if (size < from) {
          from = 0;
          rest.delete(f);
        }
        if (size === from) continue;
        const buf = Buffer.alloc(Math.min(size - from, 64 * 2 ** 20));
        let fd;
        let got = 0;
        try {
          fd = openSync(file, 'r');
          got = readSync(fd, buf, 0, buf.length, from);
        } catch {
          continue;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
        if (!got) continue;
        at.set(f, from + got);
        // Bytes, split at newlines before decoding, so a character split across two reads is decoded whole.
        const data = Buffer.concat([rest.get(f) ?? Buffer.alloc(0), buf.subarray(0, got)]);
        const end = data.lastIndexOf(10);
        rest.set(f, data.subarray(end + 1));
        const lines = end < 0 ? [] : data.subarray(0, end).toString('utf8').split('\n');
        const service = f.slice(0, -4);
        for (const line of lines) {
          if (!line.trim()) continue;
          let o = null;
          if (line.startsWith('{'))
            try {
              o = JSON.parse(line);
            } catch {
              o = null;
            }
          const req = o?.msg === 'incoming request' && o.req && typeof o.req === 'object' ? o.req : null;
          out.push({
            service,
            time: Number.isFinite(o?.time) ? o.time : null,
            served: !!req,
            method: typeof req?.method === 'string' ? req.method : null,
            path: typeof req?.url === 'string' ? req.url : null,
          });
        }
      }
      return out;
    },
  };
}

// ---- The recorder ----

/**
 * One worker's recorder. `root`: the repository (its route table is read from there); `customerPort` and `distDir`: the
 * loopback port the customer app is served on and the build on disk it serves (null when the stack serves another folder:
 * every script that ran is then `otherDist`). `take(file)` returns what this worker has
 * not attached for that journey file yet, as one record.
 */
export function makeRecorder({ root, customerPort = '3210', distDir, routes = routeTable(root) }) {
  const scripts = new Map();
  const tabled = new Set();
  const noMapSeen = new Set();
  const timeline = [];
  const sent = new Map();
  const pending = new Map();
  const withAfterAll = new Set();
  const slot = (file) => {
    if (!pending.has(file))
      pending.set(file, {
        http: new Set(),
        served: new Set(),
        active: new Set(),
        chunks: new Set(),
        ranges: new Map(),
        incomplete: new Set(),
        table: {},
        nomap: new Set(),
        after: false,
      });
    return pending.get(file);
  };
  const seen = (file) => {
    if (!sent.has(file)) sent.set(file, { http: new Set(), served: new Set(), active: new Set(), chunks: new Set(), ranges: new Map() });
    return sent.get(file);
  };
  const add = (file, kind, key) => {
    if (!seen(file)[kind].has(key)) slot(file)[kind].add(key);
  };
  return {
    request(file, url, m) {
      const k = requestKey(routes, url, m);
      if (k) add(file, 'http', k);
    },
    /** One of INCOMPLETE's codes; anything else is recorded as `noRead`, never as given. */
    incomplete(file, code) {
      slot(file).incomplete.add(Object.hasOwn(INCOMPLETE, code) ? code : 'noRead');
    },
    /** From `time` on, `file` is the journey file running (log lines are placed by their own time). */
    enter(file, time = Date.now()) {
      const t = Math.max(time, timeline.at(-1)?.[0] ?? -Infinity);
      if (timeline.at(-1)?.[1] !== file) timeline.push([t, file]);
    },
    /** Log lines (makeLogReader().read()), each to the file that ran at its time; a line with no time to `now`. */
    served(lines, now) {
      const fileAt = (t) => {
        let lo = -1;
        let hi = timeline.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (timeline[mid][0] <= t) lo = mid;
          else hi = mid - 1;
        }
        return timeline[Math.max(lo, 0)]?.[1] ?? null;
      };
      for (const l of lines ?? []) {
        if (!SERVICE.test(String(l?.service))) continue;
        const file = l.time === null ? now : fileAt(l.time);
        if (!file) continue;
        add(file, 'active', l.service);
        if (l.served) {
          const r = l.path === null ? null : routeOf(routes, String(l.path).split('?')[0]);
          add(file, 'served', `${l.service} ${method(l.method)}${r ? ` ${r}` : ''}`);
        }
      }
    },
    /** One page's coverage since its last read: `entries` are takePreciseCoverage's `result`. */
    coverage(file, entries) {
      for (const e of entries ?? []) {
        let u;
        try {
          u = new URL(e.url);
        } catch {
          continue;
        }
        if (u.port !== String(customerPort) || !LOOPBACK.has(u.hostname) || !u.pathname.endsWith('.js')) continue;
        if (!(e.functions ?? []).some((f) => f.ranges?.[0]?.count > 0)) continue;
        const p = slot(file);
        if (!distDir) {
          p.incomplete.add('otherDist');
          continue;
        }
        if (!BUILT_SCRIPT.test(u.pathname)) {
          p.incomplete.add('notBuilt');
          continue;
        }
        if (!scripts.has(u.pathname)) scripts.set(u.pathname, loadScript({ distDir, scriptPath: u.pathname }));
        const s = scripts.get(u.pathname);
        if (s.noMap) {
          if (!noMapSeen.has(u.pathname)) {
            noMapSeen.add(u.pathname);
            p.nomap.add(u.pathname);
          }
          continue;
        }
        if (s.error) {
          p.incomplete.add(s.error);
          continue;
        }
        // The script's own top level spans it whole: a length other than the file's means the page ran another build.
        const top = (e.functions ?? []).find((f) => f.ranges?.[0]?.startOffset === 0 && !f.functionName);
        if (top && top.ranges[0].endOffset !== s.text.length) {
          p.incomplete.add('otherBuild');
          continue;
        }
        if (!tabled.has(u.pathname)) {
          tabled.add(u.pathname);
          p.table[u.pathname] = [...new Set(s.sources.filter(Boolean))].sort();
        }
        const { sources, loaded } = executedRanges(s, e.functions);
        if (loaded) add(file, 'chunks', u.pathname);
        for (const [src, rs] of Object.entries(sources)) {
          if (!p.ranges.has(src)) p.ranges.set(src, []);
          p.ranges.get(src).push(...rs);
        }
      }
    },
    /** The file's afterAll hooks have run: their reach is in this file's next record, attached by a later test. */
    afterAll(file) {
      slot(file).after = true;
    },
    /** The file declares afterAll hooks: each of its records says so (`afterAllDue`), and the map reads a file whose
     *  `afterAll: true` record never came (the worker's last file: no later test attaches it) as incomplete. */
    declaresAfterAll(file) {
      withAfterAll.add(file);
    },
    /** The journey files with something not attached yet. */
    files: () => [...pending.keys()],
    take(file) {
      const p = pending.get(file);
      pending.delete(file);
      if (!p) return null;
      const s = seen(file);
      const sources = {};
      for (const [src, rs] of p.ranges) {
        const sentHere = s.ranges.get(src) ?? new Set();
        const fresh = mergeRanges(rs).filter(([a, b]) => !sentHere.has(`${a}-${b}`));
        if (!fresh.length) continue;
        for (const [a, b] of fresh) sentHere.add(`${a}-${b}`);
        s.ranges.set(src, sentHere);
        sources[src] = fresh;
      }
      for (const kind of ['http', 'served', 'active', 'chunks']) for (const k of p[kind]) s[kind].add(k);
      const record = {
        v: REACH_VERSION,
        file: path.basename(String(file)).replace(/[^A-Za-z0-9._-]/g, '_'),
        http: [...p.http].sort(),
        served: [...p.served].sort(),
        active: [...p.active].sort(),
        chunks: [...p.chunks].sort(),
        sources,
        table: p.table,
        nomap: [...p.nomap].sort(),
        incomplete: [...p.incomplete].sort(),
        ...(p.after ? { afterAll: true } : {}),
        ...(withAfterAll.has(file) && !p.after ? { afterAllDue: true } : {}),
      };
      const empty =
        !record.http.length &&
        !record.served.length &&
        !record.active.length &&
        !record.chunks.length &&
        !Object.keys(sources).length &&
        !Object.keys(p.table).length &&
        !record.nomap.length;
      return empty && !record.incomplete.length && !p.after ? null : record;
    },
  };
}
