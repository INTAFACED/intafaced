#!/usr/bin/env node
/**
 * CONFLICT KEYS — an insert that names one unique key in ON CONFLICT while its table has another.
 *
 * Two requests that insert the same row at once both pass any read before the insert. Postgres then checks the table's
 * unique keys in its own order, and `ON CONFLICT (<columns>)` absorbs a clash only on the key those columns name. When
 * another unique key of the same row is checked first, the loser of the race gets `23505` instead of the winner's row.
 * It happened twice: Buy pressed several times at once (svc-academy, `purchase_key` beside `(course_id, user_id, n)`,
 * #8378 fixed by #8417) and two first deposit-address calls (svc-pay, `(network_id, lower(address))` beside the key
 * the insert named, #8526 fixed by #8792).
 *
 * The check reads every service's unique keys from its migrations (`services/<service>/drizzle/*.sql`, in the order
 * they run) and every `INSERT … ON CONFLICT (<target>)` in that service's code, and fails an insert when its table has
 * another unique key that the statement does not absorb. An insert absorbs a key when:
 *   - it has no conflict target (`ON CONFLICT DO NOTHING` absorbs every key);
 *   - its target is that key (Postgres uses every unique index the target matches);
 *   - the key holds a column the insert does not write that the database fills with a fresh value (a serial, an
 *     identity or a random uuid default), so two inserts cannot clash on it;
 *   - the file names the key's constraint or index in a string, the way svc-pay's deposits catch `23505` on
 *     `custody_deposit_addresses_network_address_uq` and return the row that won;
 *   - or the statement says why a clash cannot happen: `conflict-keys-ok: <key name> — <reason>` in the statement or
 *     on the line above `INSERT INTO`.
 * An insert whose table the check cannot name (an interpolated table) or cannot find is listed, not failed.
 *
 * The inserts on main when the check landed are listed, each with its verdict (safe and why, or a race with its bug
 * issue), in tooling/ci/conflict-keys-baseline.json. The check fails on a finding that list does not hold, and on an
 * entry no finding matches any more, so the list only shrinks.
 *
 *   node tooling/ci/conflict-keys.mjs            fail on a new unabsorbed key, or a stale baseline entry
 *   node tooling/ci/conflict-keys.mjs --list     also print every insert of this shape, absorbed or not, one per line
 *   node tooling/ci/conflict-keys.mjs --json     the findings as JSON
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIX =
  'write `ON CONFLICT DO NOTHING` with no target when every unique key names the same row (svc-academy course-purchases.ts), ' +
  "or catch 23505 on the other key's constraint by name and return the row that won (svc-pay custody/deposits/service.ts); " +
  'if a clash on it truly cannot happen, say why on the statement: `conflict-keys-ok: <key> — <reason>`';

// ─── SQL text ────────────────────────────────────────────────────────────────

/** The SQL with comments blanked (newlines kept), quotes and dollar-quoted bodies left alone. */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? sql.length : end + tag[0].length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Top-level statements of comment-free SQL: split on `;` outside quotes, dollar quotes and parentheses. */
export function splitStatements(sql) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length - 1;
      }
    } else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth <= 0) {
      out.push(sql.slice(start, i).trim());
      start = i + 1;
      depth = 0;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/** Split on commas at parenthesis depth 0 (outside quotes). */
export function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < text.length && !(text[i] === "'" && text[i + 1] !== "'")) i += text[i] === "'" ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** The text inside the parentheses that open at `open` (an index of `(`), and the index after the closing one. */
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < text.length && !(text[i] === "'" && text[i + 1] !== "'")) i += text[i] === "'" ? 2 : 1;
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

const unquote = (s) => s.trim().replace(/"/g, '');
/** `pay.foo` / `"pay"."foo"` / `foo` → the bare table name, lower case. */
const bareName = (s) => unquote(s).split('.').pop().toLowerCase();

/** One key element (a column or an expression), compared without quotes, case, spacing, sort order or opclass. */
export function normElement(e) {
  let t = e.trim();
  for (let b; t.startsWith('(') && (b = balanced(t, 0)) && b.end === t.length;) t = b.inner.trim();
  return t
    .replace(/"/g, '')
    .replace(/\s+COLLATE\s+\S+/gi, '')
    .replace(/\s+(ASC|DESC)\b/gi, '')
    .replace(/\s+NULLS\s+(FIRST|LAST)\b/gi, '')
    .replace(/\s+[a-z_]+_ops\b/gi, '')
    .replace(/::\s*[a-z_ ]+(\[\])?/gi, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const normPredicate = (p) => (p ? normElement(p.replace(/^\(+|\)+$/g, '')) : '');
const keyId = (elements, predicate) => `${[...elements].sort().join(',')}|${predicate}`;

// ─── migrations → unique keys ────────────────────────────────────────────────

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?`;
const GENERATED =
  /\b(?:small|big)?serial\b|\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b|\bDEFAULT\s+[^,]*?\b(?:gen_random_uuid|uuid_generate_v[14]|nextval|uuidv7|gen_random_bytes)\s*\(/i;

/** A service's schema as its migrations leave it: table → { keys: Map<name, key>, generated: Set<column> }. */
export class Schema {
  constructor() {
    this.tables = new Map();
    this.indexTable = new Map(); // index or constraint name → table
  }
  table(name) {
    const t = bareName(name);
    if (!this.tables.has(t)) this.tables.set(t, { name: t, keys: new Map(), generated: new Set() });
    return this.tables.get(t);
  }
  addKey(table, name, elements, predicate = '', kind = 'unique') {
    const t = this.table(table);
    const key = { name: name.toLowerCase(), elements: elements.map(normElement), predicate: normPredicate(predicate), kind };
    key.id = keyId(key.elements, key.predicate);
    t.keys.set(key.name, key);
    this.indexTable.set(key.name, t.name);
  }
  dropKey(name) {
    const n = bareName(name);
    const t = this.indexTable.get(n);
    if (t && this.tables.get(t)) this.tables.get(t).keys.delete(n);
    this.indexTable.delete(n);
  }
  renameKey(from, to) {
    const f = bareName(from);
    const t = this.indexTable.get(f);
    const table = t && this.tables.get(t);
    const key = table?.keys.get(f);
    if (!key) return;
    table.keys.delete(f);
    key.name = bareName(to);
    table.keys.set(key.name, key);
    this.indexTable.delete(f);
    this.indexTable.set(key.name, t);
  }
}

function columnDef(schema, table, def) {
  const m = /^("[^"]+"|[A-Za-z_][\w$]*)\s+([\s\S]*)$/.exec(def.trim());
  if (!m) return;
  const col = unquote(m[1]).toLowerCase();
  const rest = m[2];
  const t = bareName(table);
  if (GENERATED.test(rest)) schema.table(t).generated.add(col);
  const named = /\bCONSTRAINT\s+("[^"]+"|\w+)\s+(?:PRIMARY\s+KEY|UNIQUE)\b/i.exec(rest);
  if (/\bPRIMARY\s+KEY\b/i.test(rest)) schema.addKey(t, named ? unquote(named[1]) : `${t}_pkey`, [col], '', 'primary key');
  else if (/\bUNIQUE\b/i.test(rest)) schema.addKey(t, named ? unquote(named[1]) : `${t}_${col}_key`, [col]);
}

/** A table constraint (`[CONSTRAINT n] PRIMARY KEY (…)` / `UNIQUE [NULLS …] (…)`); true when it was one. */
function tableConstraint(schema, table, text) {
  const t = bareName(table);
  const m =
    /^(?:CONSTRAINT\s+("[^"]+"|\w+)\s+)?(PRIMARY\s+KEY|UNIQUE)(?:\s+NULLS\s+(?:NOT\s+)?DISTINCT)?\s*(\(|USING\s+INDEX\s+("[^"]+"|\w+))/i.exec(
      text.trim(),
    );
  if (!m) return /^(?:CONSTRAINT\s+\S+\s+)?(?:CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(text.trim());
  const pk = /PRIMARY/i.test(m[2]);
  if (m[4]) {
    // ADD CONSTRAINT n UNIQUE USING INDEX idx: the index becomes the constraint, under the constraint's name.
    const idx = bareName(m[4]);
    if (m[1]) schema.renameKey(idx, unquote(m[1]));
    return true;
  }
  const open = text.indexOf('(', m.index + m[0].length - 1);
  const b = balanced(text, open);
  if (!b) return true;
  const cols = splitTopLevel(b.inner).map((c) => unquote(c).toLowerCase());
  const name = m[1] ? unquote(m[1]) : pk ? `${t}_pkey` : `${t}_${cols.join('_')}_key`;
  schema.addKey(t, name, cols, '', pk ? 'primary key' : 'unique');
  return true;
}

/** Leading PL/pgSQL control words of a statement inside a `DO` block (`IF … THEN`, `BEGIN`, `END IF`, …). */
const CONTROL =
  /^(?:DECLARE\b[\s\S]*?\bBEGIN\b|BEGIN\b|ELSIF\b[\s\S]*?\bTHEN\b|IF\b[\s\S]*?\bTHEN\b|ELSE\b|END\s+IF\b|END\s+LOOP\b|END\b|EXCEPTION\s+WHEN\b[\s\S]*?\bTHEN\b|LOOP\b)\s*/i;

function applyStatement(schema, stmt) {
  let m;
  if ((m = /^DO\s+(?:LANGUAGE\s+\w+\s+)?(\$[A-Za-z_]*\$)([\s\S]*)\1/i.exec(stmt))) {
    // Conditional DDL (`IF NOT EXISTS (…) THEN ALTER TABLE … ADD CONSTRAINT … UNIQUE …`) runs its statements as written.
    for (let inner of splitStatements(m[2])) {
      for (let prev; prev !== inner;) {
        prev = inner;
        inner = inner.replace(CONTROL, '');
      }
      if (/^(?:CREATE|ALTER|DROP)\b/i.test(inner)) applyStatement(schema, inner);
    }
    return;
  }
  if ((m = new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s*\(`, 'i').exec(stmt))) {
    const table = m[1];
    const b = balanced(stmt, m[0].length - 1);
    if (!b) return;
    schema.table(table);
    for (const el of splitTopLevel(b.inner)) {
      if (/^LIKE\b/i.test(el)) continue;
      if (!tableConstraint(schema, table, el)) columnDef(schema, table, el);
    }
    return;
  }
  if (
    (m = new RegExp(
      String.raw`^CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(?:ONLY\s+)?(${IDENT})\s*(?:USING\s+\w+\s*)?\(`,
      'i',
    ).exec(stmt))
  ) {
    const b = balanced(stmt, m[0].length - 1);
    if (!b) return;
    const where = /\bWHERE\s+([\s\S]+)$/i.exec(stmt.slice(b.end));
    if (/IF\s+NOT\s+EXISTS/i.test(m[0]) && schema.indexTable.has(bareName(m[1]))) return;
    schema.addKey(m[2], bareName(m[1]), splitTopLevel(b.inner), where ? where[1] : '');
    return;
  }
  if ((m = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i.exec(stmt))) {
    for (const n of m[1].split(',')) schema.dropKey(n);
    return;
  }
  if ((m = new RegExp(String.raw`^ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+RENAME\s+TO\s+(${IDENT})`, 'i').exec(stmt))) {
    schema.renameKey(m[1], m[2]);
    return;
  }
  if ((m = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i.exec(stmt))) {
    for (const n of m[1].split(',')) {
      const t = schema.tables.get(bareName(n));
      if (!t) continue;
      for (const k of t.keys.keys()) schema.indexTable.delete(k);
      schema.tables.delete(t.name);
    }
    return;
  }
  if ((m = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})\s+([\s\S]+)$`, 'i').exec(stmt))) {
    let table = m[1];
    for (const action of splitTopLevel(m[2])) {
      let a;
      if ((a = /^RENAME\s+TO\s+(\S+)/i.exec(action))) {
        const old = schema.tables.get(bareName(table));
        if (old) {
          schema.tables.delete(old.name);
          old.name = bareName(a[1]);
          schema.tables.set(old.name, old);
          for (const k of old.keys.keys()) schema.indexTable.set(k, old.name);
        }
        table = a[1];
      } else if ((a = /^RENAME\s+CONSTRAINT\s+(\S+)\s+TO\s+(\S+)/i.exec(action))) {
        schema.renameKey(a[1], a[2]);
      } else if ((a = /^RENAME\s+(?:COLUMN\s+)?(\S+)\s+TO\s+(\S+)/i.exec(action))) {
        const t = schema.table(table);
        const from = unquote(a[1]).toLowerCase();
        const to = unquote(a[2]).toLowerCase();
        for (const k of t.keys.values()) {
          k.elements = k.elements.map((e) => e.replace(new RegExp(String.raw`\b${from}\b`, 'g'), to));
          k.id = keyId(k.elements, k.predicate);
        }
        if (t.generated.delete(from)) t.generated.add(to);
      } else if ((a = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\S+)/i.exec(action))) {
        schema.dropKey(a[1]);
      } else if ((a = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|\w+)/i.exec(action))) {
        const t = schema.table(table);
        const col = unquote(a[1]).toLowerCase();
        for (const [name, k] of t.keys) {
          if (k.elements.some((e) => new RegExp(String.raw`\b${col}\b`).test(e))) {
            t.keys.delete(name);
            schema.indexTable.delete(name);
          }
        }
        t.generated.delete(col);
      } else if ((a = /^ADD\s+((?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|UNIQUE)\b[\s\S]*)$/i.exec(action))) {
        tableConstraint(schema, table, a[1]);
      } else if ((a = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(action))) {
        if (!/^(?:CONSTRAINT|CHECK|FOREIGN|EXCLUDE)\b/i.test(a[1])) columnDef(schema, table, a[1]);
      } else if ((a = /^ALTER\s+(?:COLUMN\s+)?("[^"]+"|\w+)\s+(?:ADD\s+GENERATED|SET\s+DEFAULT)\s+([\s\S]+)$/i.exec(action))) {
        const t = schema.table(table);
        const col = unquote(a[1]).toLowerCase();
        if (GENERATED.test(`GENERATED ${a[2]}`) || GENERATED.test(`DEFAULT ${a[2]}`)) t.generated.add(col);
        else if (/^SET\s+DEFAULT/i.test(action.replace(/^ALTER\s+(?:COLUMN\s+)?\S+\s+/i, ''))) t.generated.delete(col);
      } else if ((a = /^ALTER\s+(?:COLUMN\s+)?("[^"]+"|\w+)\s+DROP\s+(?:DEFAULT|IDENTITY)/i.exec(action))) {
        schema.table(table).generated.delete(unquote(a[1]).toLowerCase());
      }
    }
  }
}

/** Up migrations in the order the service's runner applies them (by name). */
export function migrationFiles(serviceDir) {
  const dir = join(serviceDir, 'drizzle');
  if (!existsSync(dir)) return [];
  const up = (d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort()
      .map((f) => join(d, f));
  // A subfolder (svc-notify's gateway, svc-ops's archive receiver) is another database's migrations; its tables are
  // read after the service's own.
  const subs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .sort();
  return [...up(dir), ...subs.flatMap(up)];
}

export function schemaFromSql(texts) {
  const schema = new Schema();
  for (const text of texts) for (const stmt of splitStatements(stripSqlComments(text))) applyStatement(schema, stmt);
  return schema;
}

// ─── code → inserts with a conflict target ───────────────────────────────────

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * The source with its JS/TS comments blanked to spaces (same length and lines), so prose that quotes
 * `ON CONFLICT (id) DO NOTHING` is not read as a statement. Strings and template text are kept; `${…}` code inside a
 * template is read as code.
 */
export function blankJsComments(src) {
  const out = src.split('');
  const stack = ['code']; // 'code' | 'tpl'; each `${` pushes a code frame holding its brace depth
  const depth = [0];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (c === '\\') i++;
      else if (c === '`') {
        stack.pop();
        depth.pop();
      } else if (c === '$' && src[i + 1] === '{') {
        stack.push('code');
        depth.push(0);
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
      i--;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] !== '\n') out[i] = ' ';
      i--;
    } else if (c === "'" || c === '"') {
      for (i++; i < src.length && src[i] !== c && src[i] !== '\n'; i++) if (src[i] === '\\') i++;
    } else if (c === '`') {
      stack.push('tpl');
      depth.push(0);
    } else if (c === '{') depth[depth.length - 1]++;
    else if (c === '}') {
      if (depth[depth.length - 1] === 0 && stack.length > 1) {
        stack.pop();
        depth.pop();
      } else depth[depth.length - 1]--;
    }
  }
  return out.join('');
}

/**
 * Every `INSERT INTO <table> (<columns>) … ON CONFLICT (<target>) [WHERE …] DO …` in one source file.
 * `ON CONFLICT ON CONSTRAINT <name>` is a target too. `ON CONFLICT DO …` (no target) absorbs every key and is skipped.
 */
export function insertsWithTarget(original) {
  const out = [];
  const source = blankJsComments(original);
  const re = /ON\s+CONFLICT\s*(\(|ON\s+CONSTRAINT\s+("[^"]+"|\w+))/g;
  let m;
  while ((m = re.exec(source))) {
    const before = source.slice(0, m.index);
    const inserts = [...before.matchAll(/INSERT\s+INTO\s+/g)];
    const insertAt = inserts.length ? inserts[inserts.length - 1].index : -1;
    const entry = { line: lineOf(source, m.index), insertLine: insertAt >= 0 ? lineOf(source, insertAt) : null };
    let target;
    let tail;
    if (m[2]) {
      target = { constraint: unquote(m[2]).toLowerCase() };
      tail = source.slice(m.index + m[0].length);
    } else {
      const b = balanced(source, m.index + m[0].length - 1);
      if (!b) continue;
      const after = source.slice(b.end);
      const where = /^\s*WHERE\s+([\s\S]+?)\s+DO\b/i.exec(after);
      target = { elements: splitTopLevel(b.inner).map(normElement), predicate: where ? normPredicate(where[1]) : '' };
      tail = after;
    }
    const doAt = /\bDO\s+(NOTHING|UPDATE)\b/i.exec(tail);
    entry.action = doAt ? doAt[1].toUpperCase() : '?';
    const between = insertAt >= 0 ? source.slice(insertAt, m.index) : '';
    // The insert and its ON CONFLICT must sit in one SQL text: a backtick between them means the target belongs to
    // a fragment the check cannot join to an insert.
    if (insertAt < 0 || /`/.test(withoutInterpolations(between))) {
      out.push({ ...entry, insertLine: null, table: null, reason: 'no INSERT INTO in the same SQL text', target });
      continue;
    }
    const head = /^INSERT\s+INTO\s+(\$\{[^}]*\}|[\w$."]+)\s*(?:AS\s+\w+\s*)?(\(([^)]*)\))?/i.exec(between);
    const rawTable = resolveTable(head?.[1] ?? '', source);
    const columns = head?.[3] ? splitTopLevel(head[3]).map((c) => unquote(c).toLowerCase()) : null;
    const values = (() => {
      if (!columns) return null;
      const v = /\bVALUES\s*\(/i.exec(between);
      const b = v && balanced(between, v.index + v[0].length - 1);
      if (!b) return null;
      const parts = splitTopLevel(b.inner);
      return parts.length === columns.length ? Object.fromEntries(columns.map((c, i) => [c, parts[i]])) : null;
    })();
    const lineStart = source.lastIndexOf('\n', insertAt - 1);
    const prevLineStart = source.lastIndexOf('\n', lineStart - 1);
    const endOfStatement = (() => {
      const semi = tail.search(/;|`/);
      return m.index + m[0].length + (semi === -1 ? tail.length : semi);
    })();
    const near = original.slice(prevLineStart + 1, endOfStatement);
    const allowed = [...near.matchAll(/conflict-keys-ok:\s*([\w$.]+)\s*[—-]+\s*(\S[^\n`]*)/g)].map((a) => ({
      key: a[1].toLowerCase(),
      reason: a[2].trim(),
    }));
    out.push({
      ...entry,
      table: rawTable.startsWith('${') ? null : bareName(rawTable),
      rawTable,
      reason: rawTable.startsWith('${') ? `table interpolated (${rawTable})` : null,
      columns,
      values,
      target,
      allowed,
    });
  }
  return out;
}

/** A template's text with each `${…}` removed (nested braces and nested templates included). */
export function withoutInterpolations(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
        else if (c === '`') {
          // a nested template: skip to its closing backtick, through its own interpolations
          let k = j + 1;
          while (k < text.length && text[k] !== '`') {
            if (text[k] === '$' && text[k + 1] === '{') k += withoutInterpolationsSpan(text, k);
            else k++;
          }
          j = k;
        } else if (c === "'" || c === '"') {
          const q = c;
          for (j++; j < text.length && text[j] !== q; j++) if (text[j] === '\\') j++;
        }
      }
      i = j;
    } else out += text[i];
  }
  return out;
}

/** The length of the `${…}` span that starts at `at`. */
function withoutInterpolationsSpan(text, at) {
  const rest = text.slice(at);
  const kept = withoutInterpolations(rest);
  // withoutInterpolations drops exactly the leading span, so what it kept starts where the span ended
  return rest.length - kept.length || 2;
}

/**
 * An interpolated table name, when the file says which table it is: `${t('owner_criteria')}`, or `${listings}` with
 * `const listings = relation(schema, 'library_listings')`. Anything else stays interpolated (listed, not checked).
 */
export function resolveTable(raw, source) {
  if (!raw.startsWith('${')) return raw;
  const expr = raw.slice(2, -1).trim();
  const call = /^[\w$.]+\(\s*(?:[\w$.]+\s*,\s*)?['"]([\w.]+)['"]\s*\)$/.exec(expr);
  if (call) return call[1];
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const def = new RegExp(String.raw`\b(?:const|let)\s+${expr.replace(/\$/g, '\\$')}\s*=\s*([^;\n]+)`).exec(source);
    const lit = def && /^[\w$.]+\(\s*(?:[\w$.]+\s*,\s*)?['"]([\w.]+)['"]\s*\)$|^['"]([\w.]+)['"]$/.exec(def[1].trim());
    if (lit) return lit[1] ?? lit[2];
  }
  return raw;
}

/** Every string literal's text in a JS/TS source (', ", and the static parts of template literals). */
function stringsIn(source) {
  const names = new Set();
  for (const s of source.matchAll(/'([^'\n\\]*)'|"([^"\n\\]*)"/g)) names.add((s[1] ?? s[2]).toLowerCase());
  return names;
}

const RANDOM = /\b(?:randomUUID|uuidv[47]|ulid|nanoid|randomBytes|gen_random_uuid|uuid_generate_v4)\s*\(/;

/** Names the file assigns a fresh random value to (`const id = randomUUID()`), so each call writes a new one. */
export function freshNames(source) {
  const out = new Set();
  for (const a of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]+)/g))
    if (RANDOM.test(a[2])) out.add(a[1]);
  for (const a of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*([^,\n}]+)/g)) if (RANDOM.test(a[2])) out.add(a[1]);
  return out;
}

/** A value the insert writes that is fresh on every call: a random call, or a name the file fills with one. */
function freshValue(text, fresh) {
  if (!text) return false;
  if (RANDOM.test(text)) return true;
  const ref = /^\$\{\s*(?:[\w$]+\.)*([\w$]+)\s*\}$/.exec(text.trim());
  return Boolean(ref && fresh.has(ref[1]));
}

/** The other keys of `table` this insert leaves to raise. */
export function unabsorbedKeys(insert, table, fileStrings, fresh = new Set()) {
  const keys = [...table.keys.values()];
  const arbiters = insert.target.constraint
    ? keys.filter((k) => k.name === insert.target.constraint)
    : keys.filter((k) => k.id === keyId(insert.target.elements, insert.target.predicate));
  const arbiterIds = new Set(arbiters.map((k) => k.id));
  return {
    arbiters,
    open: keys.filter((k) => {
      if (arbiterIds.has(k.id)) return false;
      if (insert.columns && k.elements.some((e) => table.generated.has(e) && !insert.columns.includes(e))) return false;
      if (insert.values && k.elements.some((e) => freshValue(insert.values[e], fresh))) return false;
      if (fileStrings.has(k.name)) return false;
      if (insert.allowed?.some((a) => a.key === k.name)) return false;
      return true;
    }),
  };
}

// ─── the scan ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'build', 'test', 'tests', '__tests__', 'fixtures']);
const CODE = /\.(?:[cm]?[jt]s)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]s$|\.db\.test\./;

function codeFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...codeFiles(join(dir, e.name)));
    } else if (CODE.test(e.name) && !TEST.test(e.name) && !e.name.endsWith('.d.ts')) out.push(join(dir, e.name));
  }
  return out;
}

export function scan(root) {
  const services = join(root, 'services');
  const rows = [];
  for (const svc of readdirSync(services).sort()) {
    const dir = join(services, svc);
    const files = migrationFiles(dir);
    const schema = schemaFromSql(files.map((f) => readFileSync(f, 'utf8')));
    for (const file of codeFiles(join(dir, 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (!/ON\s+CONFLICT/i.test(source)) continue;
      const rel = relative(root, file).split(sep).join('/');
      const fileStrings = stringsIn(source);
      const fresh = freshNames(source);
      for (const ins of insertsWithTarget(source)) {
        const row = { file: rel, line: ins.insertLine ?? ins.line, service: svc, table: ins.table, target: ins.target, action: ins.action };
        if (!ins.table) rows.push({ ...row, status: 'unread', why: ins.reason });
        else if (!schema.tables.has(ins.table))
          rows.push({ ...row, status: 'unread', why: `no table ${ins.table} in ${svc}'s migrations` });
        else {
          const { arbiters, open } = unabsorbedKeys(ins, schema.tables.get(ins.table), fileStrings, fresh);
          if (!arbiters.length) rows.push({ ...row, status: 'unread', why: 'its target matches no unique key the migrations leave' });
          else
            rows.push({
              ...row,
              status: open.length ? 'open' : 'ok',
              open,
              allowed: ins.allowed,
              others: schema.tables.get(ins.table).keys.size - 1,
            });
        }
      }
    }
  }
  return rows;
}

export const targetText = (t) =>
  t.constraint ? `ON CONSTRAINT ${t.constraint}` : `(${t.elements.join(', ')})${t.predicate ? ` WHERE ${t.predicate}` : ''}`;
const keyText = (k) => `${k.name} (${k.elements.join(', ')})${k.predicate ? ` WHERE ${k.predicate}` : ''}`;

export const BASELINE = 'tooling/ci/conflict-keys-baseline.json';
/** One finding's identity in the baseline: lines move, the file, table, target and key do not. */
export const findingId = (f) => `${f.file} | ${f.table ?? '?'} | ${f.target} | ${f.constraint}`;

/** Each finding the scan makes: one per insert and key left open, and one per insert the check cannot read. */
export function findings(rows) {
  const out = [];
  for (const r of rows) {
    if (r.status === 'open')
      for (const k of r.open)
        out.push({ file: r.file, line: r.line, table: r.table, target: targetText(r.target), constraint: k.name, keyText: keyText(k) });
    else if (r.status === 'unread')
      out.push({ file: r.file, line: r.line, table: r.table, target: targetText(r.target), constraint: 'unread', keyText: r.why });
  }
  return out;
}

/**
 * The verdict against the baseline: a finding it does not list fails (new code takes the fix, or says why on the
 * statement), and an entry no finding matches fails as stale (the list only shrinks: the insert was fixed or moved).
 */
export function judge(found, baseline) {
  const listed = new Map(baseline.map((e) => [findingId(e), e]));
  const seen = new Set(found.map(findingId));
  return {
    fresh: found.filter((f) => !listed.has(findingId(f))),
    stale: baseline.filter((e) => !seen.has(findingId(e))),
    known: found.filter((f) => listed.has(findingId(f))),
  };
}

function main() {
  const args = process.argv.slice(2);
  const root = process.cwd();
  // An empty tree is no evidence (tooling/ci/empty-denominator-gate.mjs): refuse by name, never pass over nothing.
  if (!existsSync(join(root, 'services'))) {
    console.error('CONFLICT KEYS FAILED: cannot find services/ to read migrations and inserts from');
    process.exitCode = 1;
    return;
  }
  const rows = scan(root);
  if (rows.length === 0) {
    console.error('CONFLICT KEYS FAILED: read zero inserts with a conflict target under services/*/src; the scan reads nothing');
    process.exitCode = 1;
    return;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(findings(rows), null, 2));
    return;
  }
  if (args.includes('--list')) {
    for (const r of rows) {
      const head = `${r.status.padEnd(6)} ${r.file}:${r.line} ${r.table ?? '?'} ON CONFLICT ${targetText(r.target)} DO ${r.action}`;
      if (r.status === 'open') console.log(`${head} — leaves ${r.open.map(keyText).join('; ')}`);
      else if (r.status === 'unread') console.log(`${head} — ${r.why}`);
      else console.log(`${head}${r.others ? ` — ${r.others} other key(s) absorbed` : ''}`);
    }
  }
  const baseline = existsSync(join(root, BASELINE)) ? JSON.parse(readFileSync(join(root, BASELINE), 'utf8')).entries : [];
  const { fresh, stale, known } = judge(findings(rows), baseline);
  for (const f of fresh)
    console.error(
      f.constraint === 'unread'
        ? `conflict-keys: ${f.file}:${f.line} has ON CONFLICT ${f.target} but the check cannot read its insert (${f.keyText}). ` +
            "Name the table in the SQL text, or a `const x = relation(schema, '<table>')` the check can follow."
        : `conflict-keys: ${f.file}:${f.line} inserts into ${f.table} with ON CONFLICT ${f.target}, but the table also has ` +
            `${f.keyText}: two inserts at once can clash there and the loser gets a unique violation, not the row that won. Fix: ${FIX}.`,
    );
  for (const e of stale)
    console.error(
      `conflict-keys: ${BASELINE} lists ${findingId(e)}, which the scan no longer finds: remove the entry (the list only shrinks).`,
    );
  const counts = ['ok', 'open', 'unread'].map((s) => `${rows.filter((r) => r.status === s).length} ${s}`).join(', ');
  console.error(
    `conflict-keys: ${rows.length} inserts with a conflict target (${counts}); ${known.length} open key(s) listed in ${BASELINE}, ` +
      `${fresh.length} new, ${stale.length} stale.`,
  );
  process.exitCode = fresh.length || stale.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
