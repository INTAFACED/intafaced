// A Rust service's door, as the call-records codemod reads it: each call's path, kind, access and whether its handler is
// guarded (`src/door/calls.rs`), and the refusals each guarded handler can send, read through rust-analyzer's index of
// the crate (SCIP), so a method call or a trait call reaches the function it names, never one that shares its name.
//
// A refusal is a catalogue code (`src/door/errors_table.rs`) written in the dispatch arm that answers the call
// (`src/slices/*.rs`) or in any function it reaches; a code the door sends as INTERNAL_SERVER_ERROR is a failure, not a
// named refusal, and an unguarded call names none (its refusals reach the caller as a 500).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── SCIP, the few fields read here (scip.proto: Index.documents, Document.relative_path/occurrences,
//    Occurrence.range/symbol/symbol_roles/enclosing_range) ─────────────────────────────────────────────────────────────

function wire(buf) {
  let i = 0;
  const varint = () => {
    let x = 0;
    let mul = 1;
    let b;
    do {
      b = buf[i++];
      x += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return x;
  };
  const bytes = () => {
    const n = varint();
    i += n;
    return buf.subarray(i - n, i);
  };
  return {
    more: () => i < buf.length,
    field: () => {
      const t = varint();
      return [Math.floor(t / 8), t % 8];
    },
    varint,
    bytes,
    skip(w) {
      if (w === 0) varint();
      else if (w === 1) i += 8;
      else if (w === 2) bytes();
      else if (w === 5) i += 4;
      else throw new Error(`SCIP: wire type ${w}`);
    },
  };
}
const utf8 = (b) => Buffer.from(b).toString('utf8');
const ints = (r, w) => {
  if (w !== 2) return [r.varint()];
  const p = wire(r.bytes());
  const out = [];
  while (p.more()) out.push(p.varint());
  return out;
};

function occurrenceOf(b) {
  const r = wire(b);
  const o = { range: [], symbol: '', roles: 0, enclosing: [] };
  while (r.more()) {
    const [f, w] = r.field();
    if (f === 1) o.range.push(...ints(r, w));
    else if (f === 2) o.symbol = utf8(r.bytes());
    else if (f === 3) o.roles = r.varint();
    else if (f === 7) o.enclosing.push(...ints(r, w));
    else r.skip(w);
  }
  return o;
}

function documentsOf(file) {
  const r = wire(readFileSync(file));
  const docs = [];
  while (r.more()) {
    const [f, w] = r.field();
    if (f !== 2) {
      r.skip(w);
      continue;
    }
    const d = wire(r.bytes());
    const doc = { path: '', occ: [] };
    while (d.more()) {
      const [g, x] = d.field();
      if (g === 1) doc.path = utf8(d.bytes());
      else if (g === 2) doc.occ.push(occurrenceOf(d.bytes()));
      else d.skip(x);
    }
    docs.push(doc);
  }
  return docs;
}

// ── The call graph ──────────────────────────────────────────────────────────────────────────────────────────────────

const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
const endOf = (r) => (r.length === 3 ? [r[0], r[2]] : [r[2], r[3]]);
const inside = (pos, r) => before([r[0], r[1]], pos) && before(pos, endOf(r));
const isFn = (s) => s.endsWith(').') && !s.startsWith('local ');
const CODE = /"(\w+\.[a-z0-9_]+)"/g;

/** Each line with its `//` comment cut, so a code named in a comment is never read as one sent. */
function codeLines(src) {
  return src.split('\n').map((l) => {
    let str = false;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '"' && l[i - 1] !== '\\') str = !str;
      if (!str && l[i] === '/' && l[i + 1] === '/') return l.slice(0, i);
    }
    return l;
  });
}

/**
 * The match arms that name door calls, `"a" | "b" => …` (the pattern may run over lines): each call's line range, from
 * its pattern to the next arm at the pattern's indent, or the first line indented less.
 */
export function armsOf(path, lines, calls) {
  const text = lines.join('\n');
  const lineAt = (i) => text.slice(0, i).split('\n').length - 1;
  const out = [];
  for (const m of text.matchAll(/((?:"[A-Za-z.]+"\s*\|\s*)*"[A-Za-z.]+")\s*=>/g)) {
    const names = m[1].match(/"[^"]+"/g).map((x) => x.slice(1, -1));
    if (!names.every((n) => calls.has(n))) continue;
    const from = lineAt(m.index);
    const indent = lines[from].match(/^\s*/)[0].length;
    let to = lines.length;
    for (let j = lineAt(m.index + m[0].length) + 1; j < lines.length; j++) {
      const ind = lines[j].match(/^\s*/)[0].length;
      if (!lines[j].trim()) continue;
      if (ind < indent || (ind === indent && /^\s*("|\||_\s*=>|[a-z_]+\s*=>)/.test(lines[j]))) {
        to = j;
        break;
      }
    }
    for (const n of names) out.push({ call: n, path, from, to });
  }
  return out;
}

/** The catalogue: code -> tRPC code. */
function catalogueOf(crateDir) {
  const src = readFileSync(join(crateDir, 'src/door/errors_table.rs'), 'utf8');
  return new Map([...src.matchAll(/\(\s*"(\w+\.[a-z0-9_]+)",\s*"([A-Z_]+)"/g)].map((m) => [m[1], m[2]]));
}

/** Each `Call { ... }` body in `src`, its nested braces (`Scoped { ... }`, `Post { ... }`) kept whole. */
function callBodies(src) {
  const out = [];
  for (const m of src.matchAll(/\bCall \{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** The text inside the braces that open at `opener` (its last character a `{`), nested braces kept whole; or undefined. */
function nested(src, opener) {
  const at = src.indexOf(opener);
  if (at < 0) return undefined;
  let depth = 1;
  let i = at + opener.length;
  for (; i < src.length && depth; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
  return src.slice(at + opener.length, i - 1);
}

/**
 * Who may call, as a record's `access` names it (`packages/contracts/src/procedure.ts`), or why no record can: the
 * row's `access` and its `pre`. `Access::Scope("x")` is a scope checked in the module's region (svc-academy);
 * `Access::Scope(Scoped { scope, person, module })` names each (svc-agents); `Access::Scope(Scoped { scope, tier, person,
 * region, own_session })` is svc-bank's `scopedProcedure(scope, guards)`: `region: Some(Region { .. })` is `guards.module`
 * (its `kyc`, the module's own tier rule, is what `module` checks; `kyc: None` only beside the call's own `tier`), `tier`
 * is `guards.tier`, `own_session` is `ownSession`. `Pre::PersonOnly(code)` is the record's `ownSession`; any other unit
 * `Pre` (`Pre::CoachRun`) is the record's `check` (`coachRun`). `Access::AnyScope { scopes, person: false }` is
 * `anyScopeProcedure(scopes)`; `Access::Job` is the job twin only the crate's own service may call (`job`, read from
 * `src/door/mod.rs`), a `service` record naming that service and the door's own refusal wording. Anything else (svc-agents'
 * `Settle`) is named, not guessed.
 */
function accessOf(body, module, job) {
  const pre = body.match(/pre: (Pre::[^\n]*?),?\n/)?.[1].trim();
  const ownSession = pre?.match(/^Pre::PersonOnly\("([^"]+)"\)$/)?.[1];
  // Any other unit middleware of the door's own (`Pre::CoachRun`) is the service's own check, named in the record's
  // `access.check` by its variant (`coachRun`): the door runs it, the record names it, as a mounted service's does.
  const unit = pre && pre !== 'Pre::None' && !ownSession ? pre.match(/^Pre::([A-Z]\w*)$/)?.[1] : undefined;
  if (pre && pre !== 'Pre::None' && !ownSession && !unit) return { why: `its own middleware ${pre}, which a record cannot name` };
  const check = unit ? unit[0].toLowerCase() + unit.slice(1) : undefined;
  if (/access: Access::Public\b/.test(body))
    return ownSession || check ? { why: `a public call with ${pre}` } : { access: { caller: 'public' } };
  const flat = body.match(/access: Access::Scope\("([^"]+)"\)/);
  if (flat)
    return { access: { caller: 'scope', scope: flat[1], module, ...(ownSession ? { ownSession } : {}), ...(check ? { check } : {}) } };
  const scoped = nested(body, 'access: Access::Scope(Scoped {');
  if (scoped !== undefined) {
    const text = scoped.replace(/\s+/g, ' ').trim();
    const odd = { why: `access Scoped { ${text} }, which this reader does not map to a record's` };
    // Each field the reader knows, taken out of the text; anything left over is a field it would be guessing at.
    let rest = text;
    const take = (re) => {
      const m = re.exec(rest);
      if (m) rest = rest.replace(m[0], '');
      return m;
    };
    const scope = take(/\bscope: "([^"]+)",?/)?.[1];
    const person = take(/\bperson: (true|false),?/)?.[1];
    const flag = take(/\bmodule: (true|false),?/)?.[1];
    const tierM = take(/\btier: (?:None|Some\("([^"]+)"\)),?/);
    const regionM = take(
      /\bregion: (?:None|Some\(Region \{ kyc: (?:None|Some\(Kyc \{ module: "([^"]+)", min_tier: "[^"]+",? \}\)),? \}\)),?/,
    );
    const ownM = take(/\bown_session: (?:None|Some\("([^"]+)"\)),?/);
    if (!scope || !person || rest.trim() !== '' || (flag !== undefined && regionM)) return odd;
    const tier = tierM?.[1];
    const region = regionM && !regionM[0].startsWith('region: None');
    // `kyc: None` is the door's mark that the call's own tier already asks what the module asks: without a tier, it names
    // a region checked with no tier rule, which no record names.
    if (region && regionM[1] === undefined && !tier) return odd;
    if (regionM?.[1] !== undefined && regionM[1] !== module) return odd;
    const own = ownM?.[1];
    if (own && ownSession && own !== ownSession) return odd;
    const session = own ?? ownSession;
    return {
      access: {
        caller: 'scope',
        scope,
        ...(flag === 'true' || region ? { module } : {}),
        ...(tier ? { tier } : {}),
        ...(person === 'true' ? { person: true } : {}),
        ...(session ? { ownSession: session } : {}),
        ...(check ? { check } : {}),
      },
    };
  }
  const any = nested(body, 'access: Access::AnyScope {');
  if (any !== undefined) {
    const m = /^\s*scopes: &\[((?:\s*"[^"]+",?)+)\s*\],\s*person: false,?\s*$/.exec(any);
    if (!m || ownSession || check)
      return {
        why: `access AnyScope { ${any.replace(/\s+/g, ' ').trim()} }${pre ? ` with ${pre}` : ''}, which this reader does not map to a record's`,
      };
    return { access: { caller: 'anyScope', scopes: [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) } };
  }
  if (/access: Access::Job\b/.test(body) && job && !ownSession && !check)
    return { access: { caller: 'service', callers: [job.service], forbidden: job.forbidden } };
  const other = body.match(/access: Access::(\w+)/)?.[1];
  return other ? { why: `access Access::${other}, which this reader does not map to a record's` } : undefined;
}

/**
 * Who the door's `Access::Job` admits and how it refuses anyone else, as `src/door/mod.rs`'s `admit` writes it
 * (`Access::Job => match service { None => .., Some("svc-bank") => Ok(()), Some(_) => Err(forbidden("..")) }`), or
 * undefined: a door written another way keeps its job rows named.
 */
function jobOf(crateDir) {
  const file = join(crateDir, 'src/door/mod.rs');
  if (!existsSync(file)) return undefined;
  const m =
    /Access::Job => match service \{\s*None => [^,]+,\s*Some\("([^"]+)"\) => Ok\(\(\)\),\s*Some\(_\) => Err\(forbidden\("([^"]+)"\)\),?\s*\}/.exec(
      readFileSync(file, 'utf8'),
    );
  return m ? { service: m[1], forbidden: m[2] } : undefined;
}

/**
 * `calls.rs`: path -> { kind, access (the record's, or null with `why`), guarded (null when the door has no such flag:
 * its refusals are not read) }. A row with no path, kind or access stops it.
 */
export function callsOf(crateDir, module) {
  const src = readFileSync(join(crateDir, 'src/door/calls.rs'), 'utf8');
  const job = jobOf(crateDir);
  const out = new Map();
  for (const body of callBodies(src)) {
    const path = body.match(/path: "([^"]+)"/)?.[1];
    const kind = body.match(/kind: Kind::(Query|Mutation)/)?.[1];
    const who = accessOf(body, module, job);
    const guarded = body.match(/guarded: (true|false)/)?.[1];
    if (!path || !kind || !who) throw new Error(`calls.rs: a call this reader can't read: ${body.trim()}`);
    out.set(path, {
      kind: kind.toLowerCase(),
      access: who.access ?? null,
      ...(who.why ? { why: who.why } : {}),
      guarded: guarded === undefined ? null : guarded === 'true',
    });
  }
  return out;
}

/** A record's `access` as its source writes it, keys in the order the records do. */
export function accessText(a) {
  const v = (x) => (typeof x === 'string' ? `'${x}'` : Array.isArray(x) ? `[${x.map(v).join(', ')}]` : String(x));
  return `{ ${Object.entries(a)
    .map(([k, x]) => `${k}: ${v(x)}`)
    .join(', ')} }`;
}

/**
 * The door of the crate at `crateDir` (`crates/svc-x`): `calls` as `calls.rs` writes them, and `refusals(path)`, the
 * named refusals (code -> tRPC code) a call's handler can send. Indexing the crate takes rust-analyzer a minute or two.
 */
export function doorOf(crateDir, module) {
  const calls = callsOf(crateDir, module);
  // A door with no error table (svc-agents: each slice's guard maps its own codes) names no refusals: a record lists
  // none, as one written mid-port does, and an unlisted refusal reaches the caller as the door sends it.
  if (!existsSync(join(crateDir, 'src/door/errors_table.rs')))
    return {
      calls,
      refusals: (call) => {
        if (!calls.get(call)) throw new Error(`${call}: not a call the door serves`);
        return {};
      },
    };
  const catalogue = catalogueOf(crateDir);
  const tmp = mkdtempSync(join(tmpdir(), 'door-scip-'));
  let docs;
  try {
    execFileSync('rust-analyzer', ['scip', '.', '--output', join(tmp, 'index.scip')], { cwd: crateDir, stdio: 'ignore' });
    docs = documentsOf(join(tmp, 'index.scip')).filter((d) => d.path.startsWith('src/'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const lines = new Map(docs.map((d) => [d.path, codeLines(readFileSync(join(crateDir, d.path), 'utf8'))]));
  const defsIn = new Map();
  const defined = new Set();
  for (const d of docs) {
    const list = d.occ
      .filter((o) => o.roles & 1 && isFn(o.symbol) && o.enclosing.length)
      .map((o) => ({ symbol: o.symbol, range: o.enclosing }));
    defsIn.set(d.path, list);
    for (const f of list) defined.add(f.symbol);
  }
  // A call through a trait reaches every impl of that trait's method (`impl#[Type][Trait]method().`).
  const impls = new Map();
  for (const s of defined) {
    const m = s.match(/impl#\[[^\]]*\]\[([^\]]+)\](\w+)\(\)\.$/);
    if (m) impls.set(`${m[1]}#${m[2]}`, [...(impls.get(`${m[1]}#${m[2]}`) ?? []), s]);
  }
  const targets = (sym) => {
    if (defined.has(sym)) return [sym];
    const m = sym.match(/\/(\w+)#(\w+)\(\)\.$/);
    return m ? (impls.get(`${m[1]}#${m[2]}`) ?? []) : [];
  };
  const ownerAt = (path, pos) => {
    let best;
    for (const f of defsIn.get(path) ?? []) if (inside(pos, f.range) && (!best || inside([f.range[0], f.range[1]], best.range))) best = f;
    return best?.symbol;
  };
  const add = (m, k, v) => m.set(k, (m.get(k) ?? new Set()).add(v));
  const edges = new Map();
  const codes = new Map();
  for (const d of docs) {
    for (const o of d.occ) {
      if (o.roles & 1 || !isFn(o.symbol)) continue;
      const owner = ownerAt(d.path, [o.range[0], o.range[1]]);
      if (owner) for (const t of targets(o.symbol)) add(edges, owner, t);
    }
    lines.get(d.path).forEach((l, i) => {
      for (const m of l.matchAll(CODE)) {
        const owner = ownerAt(d.path, [i, m.index]);
        if (owner) add(codes, owner, m[1]);
      }
    });
  }
  // A slice's arm may hand the call to an area's own dispatch (`tournaments::handle(ctx)`), which has the call's own arm:
  // that arm answers it, so it is read in place of the slice's.
  const arms = new Map();
  for (const path of lines.keys()) {
    if (path.startsWith('src/door/')) continue;
    for (const a of armsOf(path, lines.get(path), calls)) arms.set(a.call, [...(arms.get(a.call) ?? []), a]);
  }
  for (const [call, list] of arms) {
    const inner = list.filter((a) => !a.path.startsWith('src/slices/'));
    if (inner.length) arms.set(call, inner);
  }
  const refusals = (call) => {
    const row = calls.get(call);
    if (!row) throw new Error(`${call}: not a call the door serves`);
    if (!arms.has(call)) throw new Error(`${call}: no match arm in the crate names it`);
    if (!row.guarded) return {};
    const found = new Set();
    const stack = [];
    for (const a of arms.get(call)) {
      const doc = docs.find((d) => d.path === a.path);
      for (const o of doc.occ)
        if (!(o.roles & 1) && isFn(o.symbol) && o.range[0] >= a.from && o.range[0] < a.to) stack.push(...targets(o.symbol));
      for (let i = a.from; i < a.to; i++) for (const m of lines.get(a.path)[i].matchAll(CODE)) found.add(m[1]);
    }
    const seen = new Set();
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const c of codes.get(f) ?? []) found.add(c);
      stack.push(...(edges.get(f) ?? []));
    }
    const named = [...found].filter((c) => catalogue.has(c) && catalogue.get(c) !== 'INTERNAL_SERVER_ERROR').sort();
    return Object.fromEntries(named.map((c) => [c, catalogue.get(c)]));
  };
  return { calls, refusals };
}
