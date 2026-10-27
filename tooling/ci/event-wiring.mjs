#!/usr/bin/env node
/**
 * EVENT WIRING — a declared subject has a publisher and a subscriber, or a reason.
 *
 * ── The three failures this exists for ──────────────────────────────────────
 *
 * Three separate audits hit the event bus from three directions and each found
 * the same shape. Not one of them was found on purpose:
 *
 *   1. `bankMarginCalled` was a fully-built event. Its schema was careful, its
 *      consumer in svc-notify complete — severity `critical`, a business key of
 *      `<loanId>:<sequence>`, the lot. NOTHING PUBLISHED IT. svc-bank depended
 *      on neither `@intafaced/events` nor `nats`, and no service claimed the
 *      `bank` stream, so `INTAFACED_BANK` had never existed and svc-notify
 *      logged a consumer it could not attach on every boot since it shipped.
 *      CLOSED: svc-bank owns the stream and publishes the call
 *      (services/svc-bank/src/loans/margin-call-publisher.ts). Kept in this
 *      header because the shape is what the gate is for, not the instance —
 *      and because it was found by accident, three months after it shipped.
 *
 *   2. `xpEarned` was published by svc-p2p AND svc-trade, and read by nobody.
 *      Both producers said in their own comments that svc-identity is the way
 *      into `rank_state`; svc-identity subscribed to two blueprint subjects and
 *      nothing else. The tracker called `p2p.reputation` done on the strength of
 *      reputation "feeding the same XP graph". It did not reach the graph, so
 *      every rank shown to a P2P or trading user was wrong by what they earned.
 *      CLOSED: `subscribeXpEvents` in services/svc-identity/src/events.ts.
 *
 *   3. `orderFilled` "dropped account ids". The cause was a stale build: zod
 *      silently strips unknown keys, so a consumer compiled against an older
 *      schema deletes fields with no error anywhere. That one is fixed in
 *      `packages/events/src/bus.ts` — the bus now refuses rather than strips —
 *      and it is named here because it is the same disease: the bus could not
 *      tell anyone that two sides of a subject disagreed.
 *
 * The common shape: THE BUS COULD NOT REPORT SILENCE. An event with no producer,
 * no consumer, or a schema mismatch looked exactly like an event that was fine.
 * Each cost an engineer real time and each was found by accident.
 *
 * ── What this gate forbids ──────────────────────────────────────────────────
 *
 * Silence. Not orphans — orphans are frequently legitimate, and `ledgerTxPosted`
 * is one: a durable, replayable record ahead of its first reader, which nothing
 * derives state from and nothing claims to. What is forbidden is an orphan
 * NOBODY WROTE DOWN. Every unwired end is either an entry in `WIRING_SOCKETS`
 * (packages/events/src/catalog.ts) carrying a reason a human typed AND a class,
 * or this exits 1.
 *
 * Same principle as `workspace-sync` check 7, and the same escape hatch shape as
 * its `# no-deploy:` comment: the deliberate case must be declared, in a file a
 * reviewer reads, in prose.
 *
 * DELETING AN EVENT IS NEVER HOW YOU MAKE THIS PASS. An orphan is a finding.
 *
 * ── Why it will not cry wolf ────────────────────────────────────────────────
 *
 * A gate that fires on prose gets switched off, and then the real failure it was
 * written for goes through it unnoticed. `workspace-sync` check 6 went red on
 * `main` for everyone because it matched a COMMENT. So:
 *
 *   · comments are blanked before anything is matched — character-for-character,
 *     newlines kept, so every line number reported is the real one;
 *   · `*.test.ts` / `*.spec.ts` are not wiring. A subject that only a test
 *     publishes has no publisher;
 *   · NO regex here is built from a template literal. `\s` inside one is the
 *     letter s, which has silently broken three gates in this repo in three
 *     days (see workspace-sync checks 3b and 7). The two regexes that must be
 *     assembled are composed from `RegExp.source` of regex literals, so the
 *     escaping is written once, by the engine, in a context that cannot eat a
 *     backslash. A mutation that reintroduced the trap here SURVIVED — the
 *     pattern still matched by luck — which is why the dynamic regex it lived
 *     in was removed outright rather than corrected;
 *   · anything it cannot resolve is reported as unresolvable rather than guessed
 *     at in either direction. A gate that quietly assumes "wired" hides the bug
 *     it exists to find; one that quietly assumes "orphan" is the wolf.
 *
 * ── Sockets are not all the same thing (ADR D-S-13, Accepted 2026-08-04) ────
 *
 * This gate used to count all eighteen sockets identically, and that one number
 * covered both "the stream is a durable record ahead of its first reader" and
 * "a borrower is never told their loan is being margin-called". A written reason
 * proves somebody thought about it. It does not prove the answer was yes.
 *
 * So every socket now carries a CLASS, and the class decides whether it counts:
 *
 *   A — record ahead of its reader. Nothing depends on the consumer existing,
 *       and nothing claims it does. A true socket, legitimate indefinitely.
 *   B — a promise with no delivery. A user or an operator already believes
 *       something the missing consumer would have to deliver. NOT a socket; a
 *       defect wearing a socket's clothes. RATCHETED, not unconditionally red:
 *       the known ones are pinned by hand in `CLASS_B_AWAITING_A_DECISION`
 *       with a named decider, and a NEW one fails. See the long note there for
 *       why an unconditional red was the wrong reading of the ADR. Every Class
 *       B prints in full on every run either way.
 *   C — owned and unbuilt, AND the gap is disclosed wherever a user could
 *       otherwise be misled. A socket with a name on it.
 *
 * The test is not "is there a consumer". It is: does anyone — user or operator —
 * currently hold a belief the missing wiring would have to deliver?
 *
 * An entry that declares no class is REJECTED. A socket declaration is a claim
 * that nothing is broken, and an unclassified one is that claim made without
 * anyone having been asked to check it.
 *
 * ── WIRED MEANS MOUNTED, NOT MERELY DEFINED ─────────────────────────────────
 *
 * The fourth instance of this gate's own defect class, and it went through the
 * gate built to catch it.
 *
 * `crewMemberCreated` was a pinned Class B socket: the catalog said in as many
 * words that "svc-academy routes the lobby, svc-agents opens the crew channel"
 * and NEITHER EXISTS. Commit e1b95844 added a `crew-events.ts` to each service,
 * each exporting a `subscribeCrewMemberCreated` that calls `bus.subscribe`, and
 * DELETED the socket entry. The scan below saw two `.subscribe('crewMemberCreated')`
 * calls and agreed: wired, no socket needed, Class B count zero, green.
 *
 * Neither subscriber was ever mounted. `svc-academy/src/index.ts` does not
 * import the file — and says in its own header that the service has NO BUS
 * CONNECTION AT ALL. `svc-agents/src/index.ts` connects to NATS and never calls
 * `subscribeCrewMemberCreated`. Nothing but the two unit tests ever referenced
 * either function. The event ended up neither wired nor recorded: invisible to
 * the check, with the honest entry that preceded it deleted. Strictly worse than
 * the socket it replaced, and exactly what ADR D-S-13 calls "a check that reports
 * on something real, in a shape that gets read as evidence for something it never
 * examined."
 *
 * A TEXTUAL SCAN CANNOT TELL A DEFINED HANDLER FROM A RUNNING ONE. Existence is
 * not wiring. So a call only counts when the file it lives in is REACHABLE, and
 * the service that reaches it actually has a bus:
 *
 *   · entrypoints are derived from each service's own `package.json` (`main`, or
 *     the `node dist/….js` in `scripts.start`), mapped `dist/*.js` → `src/*.ts` —
 *     not a hardcoded `index.ts`, so a service that moves its entry moves this
 *     with it instead of quietly falling out of the graph;
 *   · the import graph is walked transitively from those entrypoints. `import
 *     type` is NOT a mount: a type-only edge is erased at compile time and
 *     mounts no handler;
 *   · a service "has a bus" when something in ITS reachable set constructs one.
 *     Keyed on the `EventBus` name suffix rather than on `JetStreamEventBus`
 *     exactly, for the same reason the relay rule keys on the type rather than
 *     on a parameter spelled `bus`: the suffix survives a rename.
 *
 * Both halves are load-bearing and svc-academy fails both — its file is not
 * imported, AND its service builds no bus, so mounting the import alone would
 * still not make the handler run. svc-agents fails only the first, which is why
 * the first alone is not enough to describe what is broken.
 *
 * A site that does not count is NOT silently dropped — silence is this gate's
 * whole enemy. Every one prints under DEFINED BUT NEVER MOUNTED, with which of
 * the two conditions it failed. It does not itself exit 1: the consequence is
 * that the event stops being counted as wired, which pushes it back to needing a
 * WIRING_SOCKETS entry — and THAT is what fails, in the place the ADR wants the
 * argument to happen.
 *
 * ── Fail closed on an empty walk ────────────────────────────────────────────
 *
 * This repo has a named recurring defect: checks that report on nothing and get
 * read as evidence. Four gates were landed to close it. So if the catalog parses
 * to zero events, or the source scan walks zero files, or the socket list parses
 * to zero entries while there is clearly text in it, or NO SERVICE ENTRYPOINT
 * RESOLVES and the reachability walk therefore mounts nothing, this exits 1
 * rather than
 * printing ✓ over a scan it never performed — the same fail-closed derivation
 * `custody-scan.mjs` uses when the module registry yields no Protocol Plane
 * service. A gate that reports green over a file it never opened is worse than
 * no gate.
 *
 * Exit 0 = every declared subject is wired at both ends or recorded as a
 * classified socket, and every Class B is one a human already pinned by name.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** Same shape `shell-brand-scan.mjs` freezes its rows with: exact, and short enough to read. */
const fingerprint = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage', 'vendor', '.git', 'drizzle']);
const ROOTS = ['services', 'apps', 'packages'];

/** Under 40 characters is a placeholder, not a reason. "TODO" is 4. */
const MIN_REASON = 40;

const failures = [];
const fail = (file, reason) => failures.push({ file, reason });

// ── source helpers ──────────────────────────────────────────────────────────

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts)$/.test(name)) yield full;
  }
}

/**
 * Replace every comment with spaces, keeping newlines and total length.
 *
 * Blanking rather than deleting is what lets every line number this gate prints
 * point at the real line in the real file — an offset-shifting strip would make
 * every reported location subtly wrong, which is its own kind of crying wolf.
 *
 * String literals are walked over rather than through, so a `//` inside a URL or
 * an apostrophe inside prose cannot start or end a comment.
 */
function blankComments(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blank(start, i);
      continue;
    }
    if (c === '/' && d === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      blank(start, i);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;
const posix = (p) => p.split('\\').join('/');
const isTestFile = (rel) => /\.(test|spec)\.(ts|tsx|mts)$/.test(rel);

// ── 1 · the catalog: what is declared, and what is recorded as unwired ───────

const catalogPath = 'packages/events/src/catalog.ts';
const catalogRaw = existsSync(join(ROOT, catalogPath)) ? readFileSync(join(ROOT, catalogPath), 'utf8') : null;
if (catalogRaw === null) {
  console.error(`  ✖ event-wiring — ${catalogPath} is missing; there is no catalog to check`);
  process.exit(1);
}

const registryBlock = /export const EVENT_CATALOG = \{([\s\S]*?)\} as const;/.exec(blankComments(catalogRaw));
if (registryBlock === null) {
  console.error(`  ✖ event-wiring — could not find "export const EVENT_CATALOG = { … } as const;" in ${catalogPath}`);
  process.exit(1);
}
const EVENTS = [...registryBlock[1].matchAll(/^\s*([A-Za-z_$][\w$]*),/gm)].map(([, name]) => name);
const isEvent = (name) => EVENTS.includes(name);

/**
 * FIRST ZERO-WALK GUARD. `EVENT_CATALOG = {}` parses fine and yields nothing,
 * and every loop below is over `EVENTS` — so a registry this cannot read makes
 * the gate agree with itself about an empty world and print ✓. Exit instead.
 */
if (EVENTS.length === 0) {
  console.error(`  ✖ event-wiring — parsed "export const EVENT_CATALOG" in ${catalogPath} and found no event in it`);
  console.error('        Either the registry changed shape or the catalog is empty. Both need a human.');
  console.error(
    '        Fail-closed: every check below iterates the catalog, so scanning zero events and printing ✓ is the bug this prevents.',
  );
  process.exit(1);
}

/**
 * The declared sockets.
 *
 * Parsed from source rather than imported, so this runs on a checkout that has
 * never been built — a gate that needs `dist` to exist cannot report on the
 * staleness of `dist`. TypeScript's `satisfies` covers what a regex cannot: an
 * entry naming an event that does not exist is a compile error over there.
 *
 * `reason` is matched as one or more single-quoted literals so a prettier-wrapped
 * or `+`-concatenated string is read whole rather than truncated.
 *
 * ENTRY-AT-A-TIME, not field-order-at-a-time. This was one regex spanning
 * `event: … missing: … reason: …` in that order, which meant a fourth field
 * could only ever be read by pinning its position too — and an entry that
 * simply omitted it would not match the regex at all, so it would vanish from
 * the socket list rather than be reported as unclassified. A socket that
 * disappears from the list because it is malformed is the worst possible
 * failure mode for a list whose whole job is that nothing disappears from it.
 *
 * So each `{ … }` in the array is isolated first, by balancing braces, and its
 * fields are read out of it individually. Order no longer matters, a missing
 * field is a NAMED failure against the entry it belongs to, and an entry that
 * parses to nothing is still counted.
 */
const socketsBlock = /export const WIRING_SOCKETS = \[([\s\S]*?)\n\] satisfies/.exec(blankComments(catalogRaw));
const sockets = [];

/** The three classes. See the header — this is the whole point of the gate. */
const CLASSES = {
  A: 'record ahead of its reader — nothing depends on the consumer existing',
  B: 'A PROMISE WITH NO DELIVERY — a defect, not a socket',
  C: 'owned and unbuilt, with the gap disclosed where a user could be misled',
};

/**
 * BOTH QUOTE STYLES, because prettier picks the quote — not the author.
 *
 * This matched single-quoted strings only, which is how the reasons were
 * written. Then `pnpm format` ran: prettier rewrites a single-quoted string
 * containing an apostrophe into a DOUBLE-quoted one to avoid the escape, and
 * nine of eighteen reasons changed quote character without a word of their
 * text changing. The gate promptly reported nine orphans that were declared
 * on the screen in front of me.
 *
 * That is the wolf, arriving from a formatter rather than from a code change,
 * and no amount of reading the regex would have found it — only running the
 * formatter did. Any parser of source text has to assume the formatter will
 * reach it.
 */
const STRING = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/;
const unquote = (s) => s.slice(1, -1).replace(/\\(.)/g, '$1');

/** Skip a string literal starting at `i`, returning the index just past it. */
function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * The top-level `{ … }` literals in `src`, by balancing braces and stepping
 * over strings. Nested objects are inside the slice rather than yielded
 * separately, because the loop resumes past the whole literal.
 */
function* objectLiterals(src) {
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c !== '{') {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    while (i < src.length) {
      const d = src[i];
      if (d === "'" || d === '"' || d === '`') {
        i = skipString(src, i);
        continue;
      }
      if (d === '{') depth++;
      else if (d === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    yield { text: src.slice(start, i), at: start };
  }
}

/** One field of an entry, read as a run of `+`-joined string literals. */
function fieldOf(entryText, name) {
  const re = new RegExp(name + ':\\s*((?:(?:' + STRING.source + ')\\s*\\+?\\s*)+)');
  const m = re.exec(entryText);
  if (m === null) return null;
  return [...m[1].matchAll(new RegExp(STRING.source, 'g'))].map(([s]) => unquote(s)).join('');
}

if (socketsBlock === null) {
  fail(
    catalogPath,
    'no "export const WIRING_SOCKETS = [ … ] satisfies readonly WiringSocket[];" — every unwired event would have nowhere to be declared, which is the silence this gate exists to forbid',
  );
} else {
  let entryCount = 0;
  for (const entry of objectLiterals(socketsBlock[1])) {
    entryCount++;
    const line = lineOf(catalogRaw, socketsBlock.index + entry.at);
    const event = fieldOf(entry.text, 'event');
    const missing = fieldOf(entry.text, 'missing');
    const reason = fieldOf(entry.text, 'reason');
    const socketClass = fieldOf(entry.text, 'class');
    const named = event === null ? `the entry at line ${line}` : `"${event}"`;

    if (event === null || missing === null || reason === null) {
      fail(
        catalogPath,
        `${named} in WIRING_SOCKETS is missing ${[event === null && 'event', missing === null && 'missing', reason === null && 'reason']
          .filter(Boolean)
          .join(', ')} (line ${line}) — an entry this gate cannot read is an entry it cannot check, and it will not skip one`,
      );
      continue;
    }

    /**
     * THE CLASS IS NOT OPTIONAL.
     *
     * A socket declaration is a claim that nothing is broken. Accepting one
     * with no class is accepting that claim from someone who was never asked
     * to make it — which is the exact shape of the eighteen this gate used to
     * count as one number (ADR D-S-13).
     */
    if (socketClass === null) {
      fail(
        catalogPath,
        `${named} in WIRING_SOCKETS declares no class (line ${line}) — every socket must state class: 'A', 'B' or 'C'. ` +
          `A = ${CLASSES.A}. B = ${CLASSES.B}. C = ${CLASSES.C}. ` +
          `A written reason proves somebody thought about it; the class is where they say what the answer was`,
      );
      continue;
    }
    if (!Object.hasOwn(CLASSES, socketClass)) {
      fail(catalogPath, `${named} in WIRING_SOCKETS declares class: "${socketClass}" (line ${line}) — it must be exactly "A", "B" or "C"`);
      continue;
    }

    sockets.push({ event, missing, reason, class: socketClass, line });
  }

  /**
   * SECOND ZERO-WALK GUARD. `WIRING_SOCKETS` legitimately reaches zero entries
   * the day the last gap closes — but only if the array is EMPTY. A block with
   * text in it that yields no entry is a parse that failed, and a parse that
   * failed silently here excuses every orphan in the repo by producing an empty
   * socket list that the checks below compare against nothing.
   */
  if (entryCount === 0 && socketsBlock[1].trim().length > 0) {
    console.error(`  ✖ event-wiring — WIRING_SOCKETS has ${socketsBlock[1].trim().length} characters in it and parsed to zero entries`);
    console.error(
      '        The array shape changed under the parser. Fail-closed: an empty socket list is how every orphan gets excused at once.',
    );
    process.exit(1);
  }
}

for (const s of sockets) {
  if (s.missing !== 'publisher' && s.missing !== 'subscriber') {
    fail(catalogPath, `the socket for "${s.event}" declares missing: "${s.missing}" — it must be exactly "publisher" or "subscriber"`);
  }
  if (!isEvent(s.event)) {
    fail(
      catalogPath,
      `WIRING_SOCKETS declares a socket for "${s.event}", which is not in EVENT_CATALOG — a socket cannot outlive the event it excuses`,
    );
  }
  if (s.reason.trim().length < MIN_REASON) {
    fail(
      catalogPath,
      `the ${s.missing} socket for "${s.event}" has a ${s.reason.trim().length}-character reason — under ${MIN_REASON} is a placeholder, and a socket list of placeholders is a suppression list. Say what is missing and why that is acceptable today`,
    );
  }
}
const seenSockets = new Set();
for (const s of sockets) {
  const key = `${s.event}::${s.missing}`;
  if (seenSockets.has(key))
    fail(
      catalogPath,
      `WIRING_SOCKETS declares the ${s.missing} socket for "${s.event}" twice — two reasons for one gap means one of them is stale`,
    );
  seenSockets.add(key);
}
const socketFor = (event, missing) => sockets.find((s) => s.event === event && s.missing === missing) ?? null;

/**
 * ── CLASS B IS A DEFECT, AND THE DEFECT IS RATCHETED ───────────────────────
 *
 * ADR D-S-13 says a Class B entry must not count as clean. The first cut of
 * this gate read that as "exit 1 while one exists", and that was wrong — not
 * about Class B, about what an unconditional red does to a repo.
 *
 * The ADR itself puts `crewMemberCreated`'s consumers on the owner ("services
 * with their own scope questions"). So no agent can ever make that entry go
 * away, and an unconditional red would be permanent, would block every
 * unrelated merge in a repo landing several PRs an hour, and would end with
 * somebody deleting the gate — taking the whole classification with it. A gate
 * that is red on every run is a gate whose red means nothing; `gates.mjs` says
 * so itself about `advisory`.
 *
 * The repo has already answered this three times — `fabricated-money-scan` (deleted 2026-10-13)
 * froze 12 findings, `vendor-java-money-scan` 63, `wallet-rpc-mainnet-scan` 38.
 * None fails on the pre-existing set. Each PINS it and fails on any deviation.
 * Same answer here.
 *
 * WHAT THIS TRADES AWAY IS THE EXIT CODE AND NOTHING ELSE. Every Class B
 * finding is printed in full on every run, in the gate's normal output, with
 * the same text the failing version used. The debt is on the summary line too,
 * because `gates.mjs` shows only the last non-empty line and a green tick over
 * an unnamed defect is how a frozen queue becomes a forgotten one.
 *
 * ── The list is HAND-WRITTEN, and derived from nothing ─────────────────────
 *
 * A pinned list computed from the catalog would agree with whatever the catalog
 * says, which is not a check. Every row is typed by a human, names WHO must
 * decide, and names WHAT would clear it — so the list reads as a decision queue
 * rather than a suppression list, and an entry nobody can name an owner for
 * cannot be added to it.
 *
 * `reasonFingerprint` pins `sha256(reason)` to 12 hex. This is the row that
 * closes the hole the ADR names by name: softening a reason until the entry
 * classifies better. Rewrite the reason and the fingerprint goes stale and the
 * gate goes red, whatever the class still says. Line numbers are deliberately
 * absent — they drift on every edit above them, and a baseline that goes stale
 * for an unrelated reason is a baseline someone deletes.
 *
 * NOTHING IS EVER ADDED HERE TO MAKE A BUILD GREEN. A new Class B is a defect
 * introduced today, and it fails.
 */
const CLASS_B_AWAITING_A_DECISION = [
  {
    event: 'crewMemberCreated',
    missing: 'subscriber',
    /**
     * RESTORED, not added. This row existed, and e1b95844 emptied this list on the
     * strength of two subscribers that have never run — see the entry in
     * catalog.ts and the header note above. Pinning it now is putting a
     * pre-existing finding back where it was, which is what the ratchet is for.
     * It is NOT the forbidden move of pinning a defect introduced today: the
     * defect is three months old, the tracker never stopped reporting it, and the
     * only thing that changed was that the gate briefly stopped being able to see
     * it.
     */
    decidedBy: 'the repo owner — ADR D-S-13 reserves these two consumers ("services with their own scope questions")',
    clearedBy:
      'svc-academy routing the lobby and svc-agents opening the crew channel FROM THEIR ENTRYPOINTS — which for svc-academy means the service ' +
      'growing a bus connection it deliberately does not have today. A crew-events.ts that nothing imports does not clear this and has already ' +
      'been mistaken for a fix once. Alternatively the owner rules the described consumers are not owed, the description is rewritten to match, ' +
      'and this drops to a Class A socket',
    reasonFingerprint: 'c020418427c6',
  },
];

const bFound = sockets.filter((s) => s.class === 'B');

/**
 * ORDER-SENSITIVE, both directions, and the fingerprint compared too.
 *
 * Order matters because a set comparison lets one entry being resolved and a
 * different one appearing cancel out — the same reason `fabricated-money-scan` (deleted 2026-10-13)
 * freezes exact text rather than a count.
 */
const pinnedKeys = CLASS_B_AWAITING_A_DECISION.map((p) => `${p.event}::${p.missing}`);
const foundKeys = bFound.map((s) => `${s.event}::${s.missing}`);

for (const s of bFound) {
  if (!pinnedKeys.includes(`${s.event}::${s.missing}`)) {
    fail(
      catalogPath,
      `NEW CLASS B — the ${s.missing} socket for "${s.event}" (line ${s.line}) is classified B and is not on CLASS_B_AWAITING_A_DECISION. ` +
        `${CLASSES.B}: something a user or an operator can already observe is premised on the consumer that does not exist, so this is not a gap ` +
        `waiting to be filled, it is a feature that does not work. Wire the missing end, or reclassify to C — which requires the gap to be ` +
        `DISCLOSED IN CODE at every surface a user could read, not asserted in the reason field. Do NOT soften the reason or the description to ` +
        `make it classify better, and do NOT add a row to the pinned list to go green: that list is a record of decisions owed by a named human, ` +
        `not a place to put a defect introduced today`,
    );
  }
}

const warnStale = (file, reason) =>
  console.log(process.env.GITHUB_ACTIONS ? `::warning file=${file},title=Event wiring::${reason}` : `  ! ${file}: ${reason}`);

for (const p of CLASS_B_AWAITING_A_DECISION) {
  const key = `${p.event}::${p.missing}`;
  const live = bFound.find((s) => `${s.event}::${s.missing}` === key);
  if (live === undefined) {
    const still = socketFor(p.event, p.missing);
    // A fix never fails the build (owner decision 2026-10-27): a stale pin warns, naming the row to delete.
    warnStale(
      catalogPath,
      `STALE PIN — CLASS_B_AWAITING_A_DECISION freezes the ${p.missing} socket for "${p.event}" as Class B, and it is ${
        still === null ? 'no longer in WIRING_SOCKETS at all' : `now classified ${still.class}`
      }. ` +
        `If the gap was closed, that is the good outcome and the row comes out of the pinned list in the same commit. If it was reclassified, say ` +
        `where the disclosure landed in code. A pin that outlives the defect it describes is a written claim that a named human still owes a ` +
        `decision they do not — which is the same lie as a socket that outlives its gap, one level up`,
    );
    continue;
  }
  const fp = fingerprint(live.reason.trim());
  if (p.reasonFingerprint !== fp) {
    fail(
      catalogPath,
      `PINNED REASON EDITED — the ${p.missing} socket for "${p.event}" is still Class B, but its reason no longer matches the frozen text ` +
        `(pinned ${p.reasonFingerprint || '<unset>'}, found ${fp}). The reason on a Class B entry is the bug report a named human is deciding ` +
        `against, and ADR D-S-13 rules out softening one to make an entry classify better. Read the diff: if the text is still an honest ` +
        `description of what is broken, update reasonFingerprint in tooling/ci/event-wiring.mjs in the same commit`,
    );
  }
}

if (pinnedKeys.length === foundKeys.length && pinnedKeys.some((k, i) => k !== foundKeys[i])) {
  fail(
    catalogPath,
    `CLASS_B_AWAITING_A_DECISION lists [${pinnedKeys.join(', ')}] and WIRING_SOCKETS declares [${foundKeys.join(', ')}] — same entries, ` +
      `different order. Compared order-sensitively on purpose: a set comparison lets one defect being resolved and another appearing cancel ` +
      `out silently, which is the whole failure a ratchet exists to prevent. Reorder the pinned list to match the catalog`,
  );
}

// ── 2 · the code: who publishes, who subscribes ─────────────────────────────

/**
 * Only a file that imports the bus can wire the bus, so that is the population.
 * A `.publish('orderFilled')` in a file that does NOT import it is reported
 * below rather than counted or ignored — see check 4.
 */
const files = [];
for (const root of ROOTS) {
  for (const abs of walk(join(ROOT, root))) {
    const rel = posix(relative(ROOT, abs));
    // packages/events is the bus itself. Its internals call `.publish()` on the
    // NATS client and its tests publish every subject in the catalog; counting
    // either would mean the bus wires itself and nothing is ever an orphan.
    if (rel.startsWith('packages/events/')) continue;
    const raw = readFileSync(abs, 'utf8');
    files.push({ rel, raw, src: blankComments(raw), test: isTestFile(rel), busAware: raw.includes('@intafaced/events') });
  }
}

/**
 * THIRD ZERO-WALK GUARD, and the one that would hurt most.
 *
 * Every "is it wired" answer below is derived from `files`. Walk zero of them —
 * a renamed root, a `ROOTS` typo, a cwd that is not the repo — and the gate
 * finds no publisher and no subscriber for anything, which does not read as an
 * error: it reads as "every socket entry is still accurate", and the whole
 * catalog gets excused by a scan that opened nothing.
 *
 * A bus-aware file count is checked as well as a raw one. Walking thousands of
 * files while resolving `@intafaced/events` in none of them is the same empty
 * scan wearing a full directory listing.
 */
const busAwareCount = files.filter((f) => f.busAware && !f.test).length;
if (files.length === 0 || busAwareCount === 0) {
  console.error(`  ✖ event-wiring — walked ${files.length} source file(s) under ${ROOTS.join('/, ')}/, ${busAwareCount} of them bus-aware`);
  console.error('        Nothing can be found wired by a scan that read nothing, so every declared event would be reported as an orphan');
  console.error('        or excused by its socket entry. Fail-closed: check the roots, and that this ran from the repo root.');
  process.exit(1);
}

// ── 2b · mounted, not merely defined ────────────────────────────────────────
//
// See the header. Everything below answers one question per wiring site: does
// the running process ever reach this file, and does the service reaching it
// have a bus for the handler to attach to?

const byRel = new Map(files.map((f) => [f.rel, f]));

/**
 * Each service's entrypoint, from its OWN package.json rather than an assumed
 * `src/index.ts`. `main: "./dist/index.js"` and `start: "node dist/index.js"`
 * both resolve back to `src/index.ts`; a service that renames its entry renames
 * this with it, instead of dropping out of the graph and taking every one of its
 * subscribers with it — which would be this gate crying wolf at full volume.
 */
const NODE_START = /\bnode\s+(\S+\.js)\b/;
function entrypointOf(serviceDir) {
  const pkgPath = join(ROOT, serviceDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
  const start = typeof pkg.scripts?.start === 'string' ? (NODE_START.exec(pkg.scripts.start)?.[1] ?? null) : null;
  const built = typeof pkg.main === 'string' ? pkg.main : start;
  if (built === null) return null;
  const rel = posix(built)
    .replace(/^\.\//, '')
    .replace(/^dist\//, 'src/')
    .replace(/\.js$/, '.ts');
  const candidate = posix(join(serviceDir, rel));
  return byRel.has(candidate) ? candidate : null;
}

const entrypoints = [];
const servicesDir = join(ROOT, 'services');
if (existsSync(servicesDir)) {
  for (const name of readdirSync(servicesDir)) {
    if (SKIP_DIRS.has(name)) continue;
    if (!statSync(join(servicesDir, name)).isDirectory()) continue;
    const entry = entrypointOf(posix(join('services', name)));
    if (entry !== null) entrypoints.push([name, entry]);
  }
}

/**
 * `import … from '…'` and `export … from '…'`, with `import type` captured so it
 * can be REJECTED. A type-only import is erased by the compiler: it mounts
 * nothing, and counting it would let a service "wire" a subscriber by importing
 * its payload type.
 *
 * Regex literals, never assembled from a template — see the note further down
 * about `\s` becoming the letter s and surviving a mutation test.
 */
const IMPORT_FROM = /\b(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*('[^']*'|"[^"]*")/g;
/** `import './side-effect.js'` — no bindings, still a mount. */
const IMPORT_BARE = /\bimport\s*('[^']*'|"[^"]*")/g;

function* importSpecifiers(src) {
  IMPORT_FROM.lastIndex = 0;
  let m;
  while ((m = IMPORT_FROM.exec(src))) {
    if (m[1]) continue; // `import type` — erased at compile time, mounts nothing.
    yield m[2].slice(1, -1);
  }
  IMPORT_BARE.lastIndex = 0;
  while ((m = IMPORT_BARE.exec(src))) yield m[1].slice(1, -1);
}

/** A relative specifier, or a workspace package. Anything else is not ours to follow. */
const WORKSPACE_PKG = /^@intafaced\/([a-z0-9-]+)$/;
function resolveImport(fromRel, spec) {
  if (spec.startsWith('.')) {
    const base = posix(join(dirname(fromRel), spec));
    const stem = base.replace(/\.js$/, '');
    for (const candidate of [base, stem + '.ts', stem + '.tsx', stem + '.mts', stem + '/index.ts']) {
      if (byRel.has(candidate)) return candidate;
    }
    return null;
  }
  const pkg = WORKSPACE_PKG.exec(spec);
  if (pkg === null) return null;
  const candidate = 'packages/' + pkg[1] + '/src/index.ts';
  return byRel.has(candidate) ? candidate : null;
}

/**
 * file → the set of services whose entrypoint transitively reaches it.
 *
 * A set rather than a boolean because a file under `packages/` can be reached by
 * several services, and "does a bus exist" has to be asked of the ones that
 * actually reach it — not of the repo in general.
 */
const reachedBy = new Map();
for (const [service, entry] of entrypoints) {
  const stack = [entry];
  while (stack.length > 0) {
    const rel = stack.pop();
    let reachers = reachedBy.get(rel);
    if (reachers === undefined) {
      reachers = new Set();
      reachedBy.set(rel, reachers);
    }
    if (reachers.has(service)) continue;
    reachers.add(service);
    const file = byRel.get(rel);
    if (file === undefined) continue;
    for (const spec of importSpecifiers(file.src)) {
      const target = resolveImport(rel, spec);
      if (target !== null) stack.push(target);
    }
  }
}

/**
 * Which services construct a bus at all.
 *
 * Suffix-keyed (`…EventBus`) rather than pinned to `JetStreamEventBus`, for the
 * same reason the relay rule keys on the `EventBus` TYPE rather than a parameter
 * named `bus`: a name rule passes today and starts reporting live consumers as
 * orphans the day somebody renames the class.
 */
const BUS_CONSTRUCTION = /\bnew\s+[A-Za-z_$][\w$]*EventBus\b|\b[A-Za-z_$][\w$]*EventBus\s*\.\s*connect\b/;
const busServices = new Set();
for (const [rel, reachers] of reachedBy) {
  const file = byRel.get(rel);
  if (file === undefined || file.test) continue;
  if (!BUS_CONSTRUCTION.test(file.src)) continue;
  for (const service of reachers) busServices.add(service);
}

/**
 * FOURTH ZERO-WALK GUARD, and it fails the same way the other three would.
 *
 * If no entrypoint resolves — a renamed `services/`, a package.json shape this
 * cannot read, a cwd that is not the repo root — then `reachedBy` is empty, every
 * wiring site in the repo reads as unmounted, and every declared event becomes an
 * orphan. That is not a quiet wrong answer; it is a loud one, and it would bury
 * the real finding under thirty fabricated ones. Exit instead of reporting it.
 */
const mountedBusAware = [...reachedBy.keys()].filter((rel) => byRel.get(rel)?.busAware && !byRel.get(rel)?.test).length;
if (entrypoints.length === 0 || mountedBusAware === 0) {
  console.error(
    `  ✖ event-wiring — resolved ${entrypoints.length} service entrypoint(s) and reached ${reachedBy.size} file(s), ${mountedBusAware} of them bus-aware`,
  );
  console.error(
    '        Reachability decides which wiring counts, so a walk that mounts nothing reports every wired subject as an orphan.',
  );
  console.error("        Fail-closed: check services/*/package.json 'main' / 'scripts.start', and that this ran from the repo root.");
  process.exit(1);
}

/**
 * Why a wiring site does or does not count. Null when it counts.
 *
 * The two conditions are reported separately because they are different bugs
 * with different fixes: "nothing imports this" is answered by mounting it,
 * "the service has no bus" is answered by giving the service one — and
 * `svc-academy` needs both, which is precisely what a single boolean would have
 * hidden.
 */
function notMountedBecause(rel) {
  const reachers = reachedBy.get(rel);
  if (reachers === undefined || reachers.size === 0) {
    return 'no service entrypoint imports it, transitively — the handler is defined and never installed';
  }
  const named = [...reachers].sort();
  if (!named.some((s) => busServices.has(s))) {
    return `reached only from ${named.join(', ')}, which construct${named.length === 1 ? 's' : ''} no bus anywhere in ${
      named.length === 1 ? 'its' : 'their'
    } own reachable set — there is nothing for the handler to attach to`;
  }
  return null;
}

/** Sites that read as wiring but never run. Printed in full; see the header. */
const definedNotMounted = [];

const publishers = new Map(EVENTS.map((e) => [e, []]));
const subscribers = new Map(EVENTS.map((e) => [e, []]));
const sideFor = (direction) => (direction === 'publish' ? publishers : subscribers);

/**
 * The one place a wiring site is admitted. Existence got it this far; this is
 * where it has to prove it runs.
 */
function record(direction, event, file, site) {
  const why = notMountedBecause(file.rel);
  if (why !== null) {
    definedNotMounted.push({ event, direction, site, why });
    return;
  }
  sideFor(direction).get(event).push(site);
}

/** Captures the dotted receiver so `hub.publish` can be told from `this.bus.publish`. */
const BUS_CALL = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(publish|subscribe)\s*(?:<[^<>()]*>)?\(\s*/g;
const FIRST_ARG_LITERAL = /^(['"])([A-Za-z_$][\w$]*)\1/;
/** `function name(`, `const name =`, `const name:` — the nearest one above an index. */
const ENCLOSING_FN = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:])/g;

/**
 * Relays: a local helper that takes the event name as a PARAMETER.
 *
 * svc-notify does not call `bus.subscribe('kycApproved', …)`. It calls a local
 * `attach(bus, 'kycApproved', …)` that wraps the subscribe so a consumer whose
 * stream does not exist yet is reported instead of thrown. A literal-only scan
 * reads all nine of its consumers as absent and declares nine false orphans —
 * including `kycApproved` and `stakeCreated`, which are wired and working.
 *
 * That is exactly the wolf this gate must not cry, so one level of indirection
 * is resolved: a named function in a bus-aware file that calls `.subscribe(x)`
 * on a non-literal becomes a subscribe-relay, and a call to it carrying a
 * catalog event literal counts as a subscriber. Module-local only — a relay is
 * matched against calls in its own file, so an unrelated same-named helper in
 * another package cannot be mistaken for one.
 *
 * `publish` and `subscribe` are ORDINARY WORDS, and this repo uses them for
 * things that are not the bus: svc-ws has a `hub.publish(update)` that fans a
 * private order to sockets, and apps/web has stores with `.subscribe(setState)`.
 * An early draft treated every one of those as a bus call, which made
 * `subscribePrivateOrders()` look like a relay publishing some undetermined
 * subject — a fabricated finding against a file that is entirely correct.
 *
 * The fix is to define a relay precisely rather than to guess from names. A
 * relay FORWARDS ITS OWN PARAMETER TO A BUS, so all four of these must hold:
 *
 *   · the file imports the bus;
 *   · the first argument is a bare identifier, not a literal or an object —
 *     `hub.publish({ … })` is excluded by its shape, with no name-matching;
 *   · that identifier is a PARAMETER of the enclosing named function, which is
 *     what makes it forwarded rather than captured;
 *   · that function takes an `EventBus`.
 *
 * The last one is load-bearing and was learned the hard way. Without it, a
 * helper like `fanOut(hub, update) { hub.publish(update) }` — a socket fan-out
 * in svc-ws, nothing to do with NATS — registers as a publish-relay for an
 * undetermined subject and the gate fails on a correct file. A mutation test
 * caught that; reading the code had not.
 *
 * And it is keyed on the TYPE rather than on the receiver being spelled `bus`.
 * A name rule also passes today and breaks the day somebody renames the
 * parameter to `eventPipe` — breaking by reporting nine wired consumers as
 * orphans, which is the one failure mode this gate must never have. The type
 * survives the rename; the name does not.
 */
const relays = new Map();
const unresolved = [];

/** The parameter list of the nearest named function above `index`, as text. */
function enclosingFunction(src, index) {
  ENCLOSING_FN.lastIndex = 0;
  let found = null;
  let match;
  while ((match = ENCLOSING_FN.exec(src)) && match.index < index) found = { name: match[1] ?? match[2], at: match.index };
  if (found === null) return null;
  const open = src.indexOf('(', found.at);
  return open === -1 ? null : { name: found.name, params: argumentListAt(src, open) };
}

for (const file of files) {
  if (file.test || !file.busAware) continue;
  BUS_CALL.lastIndex = 0;
  let call;
  while ((call = BUS_CALL.exec(file.src))) {
    const direction = call[2];
    const rest = file.src.slice(call.index + call[0].length);
    const literal = FIRST_ARG_LITERAL.exec(rest);

    if (literal) {
      // A literal that is not a catalog key is some other publish/subscribe
      // (a hub, a store). Not this gate's business.
      if (isEvent(literal[2])) record(direction, literal[2], file, `${file.rel}:${lineOf(file.src, call.index)}`);
      continue;
    }

    // Anything that is not a bare identifier is not a forwarded event name.
    const identifier = /^([A-Za-z_$][\w$]*)\s*[,)]/.exec(rest);
    if (identifier === null) continue;

    const enclosing = enclosingFunction(file.src, call.index);
    if (enclosing === null) {
      unresolved.push(
        `${file.rel}:${lineOf(file.src, call.index)} — .${direction}() on a computed name with no enclosing function to resolve it through`,
      );
      continue;
    }
    // Captured from an outer scope rather than forwarded: this gate cannot say
    // what it wires, and will not pretend either way.
    if (!new RegExp('\\b' + identifier[1] + '\\b').test(enclosing.params)) continue;
    // Forwards a parameter, but not to a bus — a socket hub, a store, an
    // observable. Not this gate's business, and treating it as one fabricates
    // a finding against a correct file.
    if (!/\bEventBus\b/.test(enclosing.params)) continue;

    relays.set(`${file.rel}::${enclosing.name}`, direction);
  }
}

/**
 * The argument list of the call whose `(` is at `open`, read by balancing
 * parentheses and skipping strings.
 *
 * A fixed-size window was the obvious thing and it is a guess: too small and a
 * relay call with a long first argument loses the event name, too large and it
 * reads into whatever follows. Balancing is exact, and it costs ten lines.
 */
function argumentListAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/**
 * NO REGEX IS BUILT FROM A NAME HERE, and that is the point.
 *
 * This loop used to compile `new RegExp(\`\\b${fn}\\s*…\`)` per relay. Writing
 * that `\\s` as `\s` inside the template literal turns it into the letter s —
 * the trap that has broken three gates in this repo in three days. Worse, a
 * mutation test of exactly that mistake SURVIVED: `attach(` has no space before
 * its parenthesis, so `s*` happily matched zero literal s and the gate reported
 * CLEAN while carrying the bug. It would have started crying wolf — nine false
 * orphans from svc-notify — the first time somebody wrote `attach (bus, …)`.
 *
 * A regex that cannot be killed by a mutation is not verified, it is lucky. So
 * the dynamic regex is gone: every call site is found ONCE with a regex literal,
 * and the captured name is looked up in the relay map. There is no template
 * literal left to get wrong.
 */
const CALL_SITE = /\b([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\(/g;
const relaysUsed = new Set();

for (const file of files) {
  if (file.test) continue;
  for (const call of file.src.matchAll(CALL_SITE)) {
    const direction = relays.get(`${file.rel}::${call[1]}`);
    if (direction === undefined) continue;

    // The event name is an argument to the relay, not necessarily the first —
    // svc-notify passes the bus first. Take the first catalog key in the list.
    const args = argumentListAt(file.src, file.src.indexOf('(', call.index + call[1].length));
    const named = [...args.matchAll(/(['"])([A-Za-z_$][\w$]*)\1/g)].map(([, , name]) => name).find(isEvent);
    if (named === undefined) continue;

    relaysUsed.add(`${file.rel}::${call[1]}`);
    record(direction, named, file, `${file.rel}:${lineOf(file.src, call.index)} (via ${call[1]}())`);
  }
}

for (const [key, direction] of relays) {
  if (relaysUsed.has(key)) continue;
  const [relayFile, fn] = key.split('::');
  unresolved.push(
    `${relayFile} — ${fn}() ${direction}es a computed event name and is never called with a catalog event, so what it wires cannot be determined`,
  );
}

// ── 3 · every declared event is wired at both ends, or recorded ─────────────

for (const event of EVENTS) {
  for (const [missing, wired] of [
    ['publisher', publishers.get(event)],
    ['subscriber', subscribers.get(event)],
  ]) {
    const socket = socketFor(event, missing);

    if (wired.length === 0 && socket === null) {
      const other = missing === 'publisher' ? subscribers.get(event) : publishers.get(event);
      const otherEnd =
        other.length > 0
          ? `the other end is live at ${other.slice(0, 2).join(', ')}${other.length > 2 ? ` (+${other.length - 2})` : ''}`
          : 'neither end is wired — this subject is declared and completely unused';

      /**
       * The unmounted sites for THIS end, named in the failure itself.
       *
       * Without this the message reads "no subscriber anywhere" to somebody
       * looking straight at a `bus.subscribe('…')` on their screen, and a gate
       * that contradicts the file open in the editor is a gate that gets
       * overruled. Say which call was found and which condition it failed.
       */
      const ghosts = definedNotMounted.filter(
        (g) => g.event === event && (g.direction === 'publish' ? 'publisher' : 'subscriber') === missing,
      );
      const ghostNote =
        ghosts.length === 0
          ? ''
          : ` NOTE — ${ghosts.length} ${missing} call(s) for this event EXIST but never run: ` +
            ghosts.map((g) => `${g.site} (${g.why})`).join('; ') +
            `. Defining a handler is not wiring it. Mount it from the service entrypoint, or record the gap.`;

      fail(
        catalogPath,
        `"${event}" has no ${missing} that a running process reaches, anywhere in services/, apps/ or packages/ — ${otherEnd}.` +
          ghostNote +
          ` Wire it, or add a WIRING_SOCKETS entry saying why an unwired ${missing} is acceptable. Do NOT delete the event: an orphan is a finding, and some are sockets waiting for a publisher`,
      );
    }

    // The other direction, and the reason this list cannot rot into a suppression
    // list: a socket kept after the gap closed is a written claim that something
    // is missing when it is not, and the next reader believes it. It warns rather
    // than fails: a fix never fails the build (owner decision 2026-10-27).
    if (wired.length > 0 && socket !== null) {
      warnStale(
        catalogPath,
        `WIRING_SOCKETS still records "${event}" as having no ${missing} (line ${socket.line}), but one exists at ${wired[0]} — delete the socket entry; a stale socket is a lie about the system that outlives the gap it described`,
      );
    }
  }
}

// ── 4 · nothing wires the bus where this gate cannot see it ─────────────────
//
// The scan above trusts one thing: that a file wiring the bus imports the bus.
// If that stops being true the gate does not go quiet about it — a subject
// published from a file it never read would be reported as an orphan (a wolf),
// or worse, a real orphan would be excused by wiring it cannot verify.
for (const file of files) {
  if (file.busAware || file.test) continue;
  for (const call of file.src.matchAll(/\.(publish|subscribe)\s*(?:<[^>()]*>)?\(\s*(['"])([A-Za-z_$][\w$]*)\2/g)) {
    if (!isEvent(call[3])) continue;
    fail(
      file.rel,
      `line ${lineOf(file.src, call.index)} ${call[1]}es the catalog event "${call[3]}" but this file does not import @intafaced/events — either it is reaching the bus by a route this gate cannot follow, or the name collides with a catalog event by accident. Both need a human`,
    );
  }
}

for (const u of unresolved) fail('event wiring', `${u} — this gate will not guess in either direction`);

// ── report ──────────────────────────────────────────────────────────────────

const wiredBoth = EVENTS.filter((e) => publishers.get(e).length > 0 && subscribers.get(e).length > 0).length;

/**
 * THE THREE CLASSES, COUNTED SEPARATELY — the line this ADR exists to change.
 *
 * One number covering both "a durable record ahead of its first reader" and
 * "a borrower is never told their loan is being margin-called" is a check that
 * reports on something real in a shape that gets read as evidence for something
 * it never examined. That is the defect class this repo has closed four times.
 * A count per class cannot be read that way.
 *
 * The B count CAN be non-zero on a run that exits 0 — but only for entries a
 * human pinned by name in `CLASS_B_AWAITING_A_DECISION`, and every one of them
 * is printed in full below whether the run is green or red. What the ratchet
 * gives up is the exit code. It does not give up saying so.
 */
const byClass = { A: 0, B: 0, C: 0 };
for (const s of sockets) if (Object.hasOwn(byClass, s.class)) byClass[s.class]++;
const classLine = `A ${byClass.A} · B ${byClass.B} · C ${byClass.C}`;

/**
 * The Class B roll-call. Printed on EVERY run, green or red, to the same stream
 * the run is reporting on — because the thing being enforced here is that a
 * defect stops being invisible, and an exit code is not the only way a check
 * says something. Same text the unconditionally-failing version printed.
 */
/**
 * DEFINED BUT NEVER MOUNTED. Printed on every run, green or red.
 *
 * These are the calls that used to be counted as wiring by their mere presence.
 * Not failing here is deliberate — the consequence lands on the event, which now
 * needs a socket entry — but not PRINTING would repeat the original sin one level
 * down: a file full of `bus.subscribe` that the gate has silently decided to
 * ignore is exactly the kind of invisible fact this whole gate exists to forbid.
 */
function reportUnmounted(out) {
  if (definedNotMounted.length === 0) return;
  out(`\n  ${definedNotMounted.length} DEFINED BUT NEVER MOUNTED — a handler that exists and does not run:`);
  for (const g of definedNotMounted) {
    out(`        · ${g.event} (${g.direction}) at ${g.site}`);
    out(`          ${g.why}`);
  }
  out('        Existence is not wiring. These do not count toward "wired end to end"; the event needs a socket entry until they run.');
}

function reportClassB(out) {
  if (bFound.length === 0) return;
  out(`\n  ${bFound.length} CLASS B — ${CLASSES.B}:`);
  for (const s of bFound) {
    const pin = CLASS_B_AWAITING_A_DECISION.find((p) => p.event === s.event && p.missing === s.missing);
    out(`        · ${s.event} (${s.missing}, line ${s.line}) — something a user or an operator can already observe is premised on the`);
    out('          consumer that does not exist, so this is not a gap waiting to be filled, it is a feature that does not work.');
    out(`          Reason, verbatim: "${s.reason.trim().slice(0, 220)}${s.reason.trim().length > 220 ? '…' : ''}"`);
    if (pin) {
      out(`          DECIDED BY: ${pin.decidedBy}`);
      out(`          CLEARED BY: ${pin.clearedBy}`);
    } else {
      out('          NOT PINNED — this one is failing the build, above.');
    }
  }
}

if (failures.length === 0) {
  console.log(
    `  ✓ event-wiring — ${EVENTS.length} declared event(s) read against ${files.length} source file(s), ` +
      `${reachedBy.size} of them mounted from ${entrypoints.length} service entrypoint(s): ` +
      `${wiredBoth} wired end to end, ${sockets.length} recorded socket(s), each with a written reason and a class (${classLine})`,
  );
  console.log(`        A = ${CLASSES.A}. C = ${CLASSES.C}.`);
  reportUnmounted(console.log);
  reportClassB(console.log);
  // `gates.mjs` prints only the LAST non-empty line as this gate's summary, so
  // the debt has to be on it. A green tick over an unnamed defect is how a
  // frozen queue becomes a forgotten one.
  if (bFound.length > 0) {
    console.log(
      `\n  ⚠ ${bFound.length} Class B defect(s) frozen in CLASS_B_AWAITING_A_DECISION, each awaiting a named decision — the list cannot grow, ` +
        `and a new Class B fails: ${CLASS_B_AWAITING_A_DECISION.map((p) => `${p.event} → ${p.decidedBy.split(' —')[0]}`).join(' · ')}`,
    );
  } else {
    console.log('        No Class B: nothing here is a promise a user already believes with no delivery behind it.');
  }
  process.exitCode = 0;
} else {
  console.error(`  ✖ event-wiring — ${failures.length} problem(s); socket classes: ${classLine}`);
  for (const f of failures) console.error(`        · ${f.file}: ${f.reason}`);
  reportUnmounted(console.error);
  reportClassB(console.error);
  console.error('\n  A subject nobody publishes, or nobody reads, is not a contract — and the bus cannot tell you on its own (§10).');
  process.exitCode = 1;
}
