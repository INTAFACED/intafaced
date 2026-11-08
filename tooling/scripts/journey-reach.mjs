/**
 * What a journey reached, recorded while it runs (apps/customer/tests/real-app/journey.mjs), so a later map can say which
 * journeys a product change can break from evidence, not a guess (project-state STATE.md, the binding constraint: every
 * pull request runs the whole suite because nothing says which journeys its code reaches). This file only records; the
 * map and its use in the merge seal are separate changes.
 *
 * One record per test, attached to the Playwright report as `journey-reach` (application/json), holding only what this
 * worker had not attached for the same journey file yet:
 *   - http: every request a journey's Node code or its browser pages sent, and every WebSocket they opened, as
 *     `<port> <METHOD> <path template>` (ids, hashes, addresses and numbers in the path read `:id`; no query, no host,
 *     no body), so a port names a service of the stack and a path an Edge route;
 *   - chunks: the customer app's scripts each page ran, by their path in the build (`/assets/index-1a2b.js`);
 *   - sources: for each source file of the customer app (and the packages it bundles), the line ranges of the functions
 *     that ran at least once, read from Chromium's precise coverage and mapped back through the build's hidden source
 *     maps (`vite build` with INTAFACED_SOURCEMAP=hidden, set by the local test stack);
 *   - table: the first time this worker sees a chunk, the source files its map lists (a chunk that loaded evaluated every
 *     module in it);
 *   - nomap: the first time this worker sees one, a script that ran and was built with no map (the boot script, the
 *     bundler's runtime, prebuilt vendor code). Its sources are in no table, so the map reads them as unmapped: full;
 *   - afterAll: true on the record that carries a file's afterAll hooks' requests (attached by the next file's first
 *     test, since a hook after the last test has no test to attach to; a file with afterAll hooks and no such record, the
 *     last in its shard, is read as incomplete by the map);
 *   - incomplete: why this test's record can't be read as whole, when it can't (a page the app opened by itself, a page
 *     closed before its coverage was read, a script with no map, a coverage read that failed). A map built from records
 *     treats an incomplete journey as reaching every source.
 * Recording never changes a request or a page, and never fails a test.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const REACH_ATTACHMENT = 'journey-reach';
export const REACH_VERSION = 1;

// ---- URLs ----

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8,}|0x[0-9a-fA-F]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{20,}|[^@/]+@[^@/]+|[A-Z0-9]{2,}[-_][A-Z0-9][-_A-Z0-9]*|.*\d.*\d.*\d.*)$/;

/** A built or static file (`index-1a2b.js`, `font.woff2`): the scripts a page ran are recorded as chunks, not paths. */
const STATIC_FILE = /\.(?:js|mjs|css|map|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|ico|webm|mp4|json|txt|html)$/i;

/** A path's template: a built or static file reads `:file`, and a segment that looks like an id, a hash, an address, an email or holds three digits reads `:id`. */
export function pathTemplate(pathname) {
  return (
    String(pathname || '/')
      .split('/')
      .map((s) => {
        let d = s;
        try {
          d = decodeURIComponent(s);
        } catch {
          /* kept as written */
        }
        if (d && STATIC_FILE.test(d)) return ':file';
        return d && ID_SEGMENT.test(d) ? ':id' : d.replace(/[\u0000-\u001f\u007f\s]/g, '_');
      })
      .join('/') || '/'
  );
}

/** `<port> <METHOD> <template>` for a URL the stack serves (loopback), or null for anything else (a data: URL, an outside host). */
export function requestKey(url, method = 'GET') {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return null;
  if (!LOOPBACK.has(u.hostname)) return null;
  const port = u.port || (/^(https|wss):$/.test(u.protocol) ? '443' : '80');
  const m = /^wss?:$/.test(u.protocol) ? 'WS' : String(method || 'GET').toUpperCase();
  return `${port} ${m} ${pathTemplate(u.pathname)}`;
}

// ---- Source maps ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VAL = new Map([...B64].map((c, i) => [c, i]));

/** A source map's `mappings`, decoded: per generated line, [genCol, srcIndex, srcLine (0-based)] sorted by genCol. */
export function decodeMappings(mappings) {
  const lines = [];
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let name = 0;
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
        if (d === undefined) throw new Error(`bad base64 VLQ digit ${JSON.stringify(c)}`);
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
        srcCol += vals[3];
        if (vals.length >= 5) name += vals[4];
        segs.push([genCol, src, srcLine]);
      }
    }
    segs.sort((a, b) => a[0] - b[0]);
    lines.push(segs);
  }
  return lines;
}

/**
 * A source path as the repository names it (`apps/customer/src/x.tsx`, `packages/ui/src/y.ts`), from a map's `sources`
 * entry resolved against the map's own folder; null for a dependency (node_modules) or anything outside the repository.
 */
export function repoSource(root, mapFile, source, sourceRoot = '') {
  const abs = path.resolve(path.dirname(mapFile), sourceRoot || '', String(source).replace(/^[a-z]+:\/\/\/?/i, ''));
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split('/').includes('node_modules')) return null;
  return rel;
}

/** One script's text and map, read from the build on disk, ready for offset lookups; or { error }. */
export function loadScript({ root, distDir, scriptPath }) {
  const file = path.join(distDir, scriptPath.replace(/^\/+/, ''));
  if (!path.resolve(file).startsWith(path.resolve(distDir) + path.sep)) return { error: `outside the build: ${scriptPath}` };
  if (!existsSync(file)) return { error: `not in the build: ${scriptPath}` };
  const mapFile = `${file}.map`;
  if (!existsSync(mapFile)) return { noMap: true, error: `no source map: ${scriptPath}` };
  try {
    const text = readFileSync(file, 'utf8');
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const sources = (map.sources ?? []).map((s) => repoSource(root, mapFile, s, map.sourceRoot));
    return { text, starts, lines: decodeMappings(map.mappings), sources };
  } catch (e) {
    return { error: `unreadable map for ${scriptPath}: ${e.message}` };
  }
}

/** The source and line (1-based) a generated offset maps to, or null. */
export function originalAt(script, offset) {
  let lo = 0;
  let hi = script.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (script.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  const col = offset - script.starts[lo];
  const segs = script.lines[lo] ?? [];
  let best = null;
  for (const s of segs) {
    if (s[0] <= col) best = s;
    else break;
  }
  if (!best) return null;
  const source = script.sources[best[1]];
  return source ? { source, line: best[2] + 1 } : null;
}

/**
 * The functions that ran in one script's coverage (CDP Profiler.takePreciseCoverage `functions`, with call counts), as
 * line ranges per source: { sources: { [source]: [[startLine, endLine]] }, loaded: boolean }. The script's own top level
 * (the function spanning offset 0) means the chunk loaded; it is reported as `loaded`, not as a range.
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
    const a = originalAt(script, r.startOffset);
    if (!a) continue;
    const b = originalAt(script, Math.max(r.startOffset, r.endOffset - 1));
    const end = b && b.source === a.source && b.line >= a.line ? b.line : a.line;
    (out[a.source] ??= []).push([a.line, end]);
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

// ---- The recorder ----

/**
 * One worker's recorder. `root`: the repository; `customerPort` and `distDir`: the loopback port the customer app is
 * served on and the build on disk it serves. `note(file, kind, value)` collects; `take(file)` returns what this worker has not
 * attached for that journey file yet, as one record, and forgets the incomplete reasons it returned.
 */
export function makeRecorder({ root, customerPort = '3210', distDir }) {
  const scripts = new Map(); // scriptPath -> loadScript result
  const tabled = new Set(); // chunks whose source table this worker already attached
  const noMapSeen = new Set(); // scripts with no map this worker already named
  const sent = new Map(); // file -> { http:Set, chunks:Set, ranges: Map(source -> Set("a-b")) }
  const pending = new Map(); // file -> { http:Set, chunks:Set, ranges: Map(source -> ranges[]), incomplete:Set, table:{} }
  const slot = (file) => {
    if (!pending.has(file))
      pending.set(file, {
        http: new Set(),
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
    if (!sent.has(file)) sent.set(file, { http: new Set(), chunks: new Set(), ranges: new Map() });
    return sent.get(file);
  };
  return {
    request(file, url, method) {
      const k = requestKey(url, method);
      if (k && !seen(file).http.has(k)) slot(file).http.add(k);
    },
    /** The file's afterAll hooks have run: their requests are in this file's next record, attached by a later test. */
    afterAll(file) {
      slot(file).after = true;
    },
    /** The journey files with something not attached yet. */
    files: () => [...pending.keys()],
    incomplete(file, why) {
      slot(file).incomplete.add(String(why).slice(0, 300));
    },
    /** One page's coverage since its last read: `entries` are takePreciseCoverage's `result`. */
    coverage(file, entries) {
      for (const e of entries ?? []) {
        let u;
        try {
          u = new URL(e.url);
        } catch {
          continue; // an eval'd or anonymous script: no file to map
        }
        if (u.port !== String(customerPort) || !LOOPBACK.has(u.hostname) || !u.pathname.endsWith('.js')) continue;
        const ran = (e.functions ?? []).some((f) => f.ranges?.[0]?.count > 0);
        if (!ran) continue;
        if (!scripts.has(u.pathname)) scripts.set(u.pathname, loadScript({ root, distDir, scriptPath: u.pathname }));
        const s = scripts.get(u.pathname);
        const p = slot(file);
        if (s.noMap) {
          // A script built with no map (the boot script, the bundler's runtime, prebuilt vendor code): none of its sources
          // is in any chunk's table, so a map built from these records reads them as unmapped, and a change to one of
          // them as a full run. Recorded once per worker, so the map can name them.
          if (!noMapSeen.has(u.pathname)) {
            noMapSeen.add(u.pathname);
            p.nomap.add(u.pathname);
          }
          continue;
        }
        if (s.error) {
          p.incomplete.add(`customer script ${u.pathname} ran but can't be mapped (${s.error})`);
          continue;
        }
        // The script's own top level spans it whole: a length other than the file's means the build on disk is not the
        // one the page ran (another build served, or rebuilt since), so its map would point at the wrong lines.
        const top = (e.functions ?? []).find((f) => f.ranges?.[0]?.startOffset === 0 && !f.functionName);
        if (top && top.ranges[0].endOffset !== s.text.length) {
          p.incomplete.add(
            `customer script ${u.pathname} ran with ${top.ranges[0].endOffset} characters, the build on disk has ${s.text.length}`,
          );
          continue;
        }
        if (!tabled.has(u.pathname)) {
          tabled.add(u.pathname);
          p.table[u.pathname] = [...new Set(s.sources.filter(Boolean))].sort();
        }
        const { sources, loaded } = executedRanges(s, e.functions);
        if (loaded && !seen(file).chunks.has(u.pathname)) p.chunks.add(u.pathname);
        for (const [src, rs] of Object.entries(sources)) {
          if (!p.ranges.has(src)) p.ranges.set(src, []);
          p.ranges.get(src).push(...rs);
        }
      }
    },
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
      for (const k of p.http) s.http.add(k);
      for (const c of p.chunks) s.chunks.add(c);
      const record = {
        v: REACH_VERSION,
        file: path.basename(String(file)),
        http: [...p.http].sort(),
        chunks: [...p.chunks].sort(),
        sources,
        table: p.table,
        nomap: [...p.nomap].sort(),
        incomplete: [...p.incomplete].sort(),
        ...(p.after ? { afterAll: true } : {}),
      };
      const empty =
        !record.http.length &&
        !record.chunks.length &&
        !Object.keys(sources).length &&
        !Object.keys(p.table).length &&
        !record.nomap.length;
      return empty && !record.incomplete.length && !p.after ? null : record;
    },
  };
}
