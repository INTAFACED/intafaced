/**
 * What a local test stack's state folder keeps that only holds while its database does.
 *
 * The throwaway server runs without crash durability, so a data directory left by an unclean stop (a box restart) is made
 * again (local-test-stack.mjs ensurePostgres). The state folder outlives it: founders.json and operators.json still name
 * accounts by id, and the stack then signs in as people identity no longer holds (`auth.invalid_credentials`, #10352).
 * A file whose accounts are all gone is moved aside, never deleted, so the stack enrols a fresh pair. A file with some
 * accounts present and some gone is refused: enrolling again would collide with the accounts that remain.
 *
 * The beta host keeps its database across restarts instead (LOCAL_STACK_PG_DURABLE=1, set by tooling/beta/beta-host.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Crash durability off: CI's service database and the tests' own containers run the same way (#9610). */
const PG_THROWAWAY_FLAGS = '-c fsync=off -c synchronous_commit=off -c full_page_writes=off';

/** True when this stack keeps its database through a crash or restart: durable writes, and an unclean stop is recovered. */
export const pgDurable = (env = process.env) => env.LOCAL_STACK_PG_DURABLE === '1';

/** The server flags `pg_ctl start` passes after the port and host: none for a durable stack. */
export const pgServerFlags = (env = process.env) => (pgDurable(env) ? '' : PG_THROWAWAY_FLAGS);

/** The state files that name identity accounts, with the account ids each names and the files that go with it. */
const ACCOUNT_FILES = [
  {
    file: 'founders.json',
    ids: (json) => (Array.isArray(json?.founders) ? json.founders.map((f) => f?.userId) : []),
    companions: ['founder-totp-steps.json', path.join('run', 'identity-founder-pin.json')],
  },
  {
    file: 'operators.json',
    ids: (json) => Object.values(json?.operators ?? {}).map((o) => o?.userId),
    companions: [],
  },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account ids a state file names (valid UUIDs only), or none when the file is missing or unreadable. */
function namedAccountIds(stateDir, entry, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let json;
  try {
    json = JSON.parse(read(path.join(stateDir, entry.file)));
  } catch {
    return [];
  }
  return entry.ids(json).filter((id) => typeof id === 'string' && UUID_RE.test(id));
}

/**
 * Which account files to move aside, given the ids identity holds now (`present`, lower-case). Throws on a file with
 * some of its accounts present and some gone.
 */
export function lostAccountFiles(stateDir, present, { read } = {}) {
  const lost = [];
  for (const entry of ACCOUNT_FILES) {
    const ids = namedAccountIds(stateDir, entry, { read });
    if (ids.length === 0) continue;
    const gone = ids.filter((id) => !present.has(id.toLowerCase()));
    if (gone.length === 0) continue;
    if (gone.length < ids.length)
      throw new Error(
        `${entry.file} names ${ids.length} accounts and identity holds only ${ids.length - gone.length} of them; ` +
          `move it aside by hand once the database is the one you want`,
      );
    lost.push(entry);
  }
  return lost;
}

/** Move each lost file and its companions to `<name>.lost-<stamp>` beside it. Returns the paths moved. */
export function retireAccountFiles(stateDir, entries, { now = new Date(), rename = fs.renameSync, exists = fs.existsSync } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const moved = [];
  for (const entry of entries) {
    for (const rel of [entry.file, ...entry.companions]) {
      const from = path.join(stateDir, rel);
      if (!exists(from)) continue;
      const to = `${from}.lost-${stamp}`;
      rename(from, to);
      moved.push(to);
    }
  }
  return moved;
}
