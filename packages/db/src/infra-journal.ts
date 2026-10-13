import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INFRA JOURNAL — a skipped suite has to leave a mark
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 *
 * An agent ran `pnpm verify` three times. Run 2 printed:
 *
 *     Tasks:    92 successful, 92 total
 *
 * and meant nothing. Postgres had saturated under parallel load, the two-second
 * connect probe in `postgresAvailable` timed out, and every database-backed
 * suite took its `describe.skip` branch. Fourteen suites did not execute. Turbo
 * counted fourteen successes, because from turbo's side of the process boundary
 * a vitest run with zero assertions and a vitest run that proved the ledger
 * balances are the same event: exit code 0.
 *
 * That number was *true*. `pnpm verify` did run 92 tasks and none of them
 * failed. It was also useless, and worse than useless, because it is the sentence
 * a human reads and stops reading. Several agents lost a day to it this week.
 *
 * THE ASYMMETRY THAT MADE IT DANGEROUS
 *
 * A run gets GREENER as the machine gets more loaded. Contention makes the probe
 * time out; a timed-out probe skips; a skipped suite cannot fail. So the exact
 * conditions under which you most want the tests to run are the conditions under
 * which they quietly do not, and nothing anywhere in the output says so.
 *
 * WHY NOT JUST FAIL
 *
 * Because the skip guards are right. A developer with no Docker must still be
 * able to run `pnpm verify` and get value from the 800-odd tests that need no
 * infrastructure. A gate that makes `verify` unrunnable on a laptop gets
 * reverted within a day, and then we have neither the tests nor the honesty.
 *
 * So the fix is not "fail". The fix is that **skipping stops being invisible**.
 * Every probe for an external dependency writes one line here, whichever way it
 * went, and `tooling/ci/infra-verdict.mjs` turns those lines into a verdict that
 * is printed after turbo's summary and contradicts it in plain English when the
 * run did not actually execute.
 *
 * WHY A FILE AND NOT A REPORTER
 *
 * Every package runs its own `vitest run` in its own process, under turbo, in
 * parallel, with no shared config file to hang a reporter on. A directory of
 * one-record files needs no coordination, no locking, no config in twenty
 * packages, and survives a worker being killed. `test` is `"cache": false` in
 * turbo.json, so the journal can never be replayed from a cache and go stale.
 */

/** The external dependencies a suite is allowed to skip itself over. */
export type InfraDependency = 'postgres' | 'evm-chain' | 'nats';

/**
 * What the probe decided.
 *
 * `ran` — the dependency answered and the suite executed.
 * `skipped` — it did not answer, nothing required it, the suite did not run.
 * `required-failed` — it did not answer and CI/REQUIRE_* demanded it. The probe
 *   throws in this case; the record exists so the verdict can name the suite
 *   even when the throw is what the reader sees first.
 */
export type InfraOutcome = 'ran' | 'skipped' | 'required-failed';

export interface InfraProbe {
  readonly dependency: InfraDependency;
  readonly outcome: InfraOutcome;
  /** Where the probe pointed, credentials removed. */
  readonly target: string;
  /** Repo-relative test file, when the stack could name one. */
  readonly suite: string;
  /** Driver message when the probe failed. Empty on `ran`. */
  readonly reason: string;
  /** Coarse machine-readable cause — see `classifyReason`. */
  readonly cause: InfraCause;
  readonly at: string;
  readonly runId: string;
}

/**
 * Absence and contention look identical in a summary and are completely
 * different problems. "Nothing is listening on 5433" is a laptop without Docker
 * and is fine. "Postgres accepted no connection within two seconds" or
 * "too_many_connections" is a database that EXISTS and was overwhelmed — which
 * is the false-green shape from the incident, and the verdict says so in
 * different words.
 */
export type InfraCause = 'none' | 'absent' | 'contended' | 'refused-auth' | 'other';

const RUN_ID_ENV = 'INTAFACED_RUN_ID';
const JOURNAL_DIR_ENV = 'INTAFACED_INFRA_JOURNAL';

/** Journal entries older than this are from a previous run and are ignored. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Walk up for the workspace root so every package, worktree and vitest worker
 * agrees on one journal without anyone passing a path. Worktrees get their own
 * root and therefore their own journal, which is the point — two agents running
 * `verify` at once must not read each other's skips.
 */
function workspaceRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    try {
      statSync(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return resolve(from);
      dir = parent;
    }
  }
}

export function infraJournalDir(): string {
  const override = process.env[JOURNAL_DIR_ENV];
  if (override && override.trim() !== '') return override;
  return join(workspaceRoot(), '.intafaced-run', 'infra');
}

function currentRunId(): string {
  return process.env[RUN_ID_ENV] ?? 'ad-hoc';
}

/**
 * Strip credentials. The journal is a plain file in the working tree and
 * `pnpm scan:secrets` exists for a reason; a URL with a password in it must not
 * be written somewhere a `cat` or a screenshot can pick it up.
 *
 * `URL.password` only sees userinfo. libpq also accepts `?password=` on a URI
 * that parses, and a keyword DSN (`password=`) that does not parse at all.
 */
export function redactUrl(raw: string): string {
  const scrub = (value: string): string =>
    value
      .replace(/\/\/([^:@/\s]*):[^@/\s]*@/g, '//$1:***@')
      .replace(/([?&])([^=&\s]+)=([^&\s]*)/g, (pair, separator: string, key: string) => {
        try {
          return decodeURIComponent(key).toLowerCase() === 'password' ? `${separator}${key}=***` : pair;
        } catch {
          return pair;
        }
      })
      // libpq permits spaces around '=' and single-quoted values with escaped
      // quotes or spaces. Redacting only the first whitespace token leaks the rest.
      .replace(/(^|\s)(password\s*=\s*)(?:'(?:\\[\s\S]|[^'\\])*(?:'|$)|(?:\\[\s\S]|[^\s\\])*)/gi, '$1$2***');
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    const search = scrub(url.search);
    if (search !== url.search) url.search = search;
    // Error text can parse as an opaque URL (for example "error: ...").
    // Scrub embedded DSNs too, rather than relying on URL.password alone.
    return scrub(url.toString());
  } catch {
    return scrub(raw);
  }
}

/**
 * A readable cause from a driver error.
 *
 * `postgres.js` throws errors whose `.message` is frequently empty and whose
 * only useful content is `.code`. A record reading `reason: ""` tells the reader
 * nothing, and — worse — leaves the verdict unable to tell absence from
 * contention, which is the one distinction it exists to draw.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err ?? '');
  const extra = err as Error & { code?: unknown; errno?: unknown };
  const parts: string[] = [];
  if (typeof extra.code === 'string' || typeof extra.code === 'number') parts.push(String(extra.code));
  if (err.message) parts.push(err.message);
  if (typeof extra.errno === 'string' && extra.errno !== '') parts.push(extra.errno);
  return [...new Set(parts)].join(' — ');
}

/**
 * Which test file asked. Read off the stack rather than added as a parameter to
 * every probe, because the alternative is twenty call sites each free to pass
 * the wrong string or nothing at all — and a journal that under-reports is the
 * same disease as a summary that under-reports.
 */
function callerSuite(): string {
  const stack = new Error().stack ?? '';
  const root = workspaceRoot();
  for (const line of stack.split('\n').slice(1)) {
    const match = /\(?((?:file:\/\/\/|[A-Za-z]:|\/)[^()]*?\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(line);
    if (!match?.[1]) continue;
    let file = match[1];
    if (file.startsWith('file:///')) {
      try {
        file = decodeURIComponent(new URL(file).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      } catch {
        /* keep the raw form */
      }
    }
    return relative(root, file).replace(/\\/g, '/');
  }
  return '<unknown suite>';
}

/** Map a driver error onto the distinction that actually changes what you do. */
export function classifyReason(reason: string): InfraCause {
  const text = reason.toLowerCase();
  if (text === '') return 'none';
  if (text.includes('econnrefused') || text.includes('enotfound') || text.includes('ehostunreach') || text.includes('fetch failed')) {
    return 'absent';
  }
  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('etimedout') ||
    text.includes('too_many_connections') ||
    text.includes('too many clients') ||
    text.includes('53300') ||
    text.includes('connection terminated') ||
    text.includes('econnreset')
  ) {
    return 'contended';
  }
  if (text.includes('password') || text.includes('authentication') || text.includes('role ') || text.includes('28p01')) {
    return 'refused-auth';
  }
  return 'other';
}

export interface RecordInfraProbeInput {
  dependency: InfraDependency;
  outcome: InfraOutcome;
  target: string;
  reason?: string;
  /** Override the stack-derived suite name. Only tooling should need this. */
  suite?: string;
}

/**
 * Append one record. Never throws: an honesty mechanism that can fail the suite
 * it is observing would be its own outage, and would be disabled within a week.
 */
export function recordInfraProbe(input: RecordInfraProbeInput): void {
  try {
    const reason = redactUrl(input.reason ?? '');
    const probe: InfraProbe = {
      dependency: input.dependency,
      outcome: input.outcome,
      target: redactUrl(input.target),
      suite: input.suite ?? callerSuite(),
      reason: reason.slice(0, 400),
      cause: classifyReason(reason),
      at: new Date().toISOString(),
      runId: currentRunId(),
    };
    const dir = infraJournalDir();
    mkdirSync(dir, { recursive: true });
    // One file per record: parallel vitest workers across twenty packages never
    // need a lock, and a killed worker cannot corrupt anyone else's line.
    appendFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(probe));
  } catch {
    /* Journalling is best-effort by construction. */
  }
}

/**
 * Every record for the current run.
 *
 * When `INTAFACED_RUN_ID` is set (the `verify` wrapper sets it) only that run's
 * records are returned, so a stray `pnpm test` from an hour ago cannot colour
 * this verdict. Without it, anything older than six hours is dropped.
 */
export function readInfraProbes(runId = process.env[RUN_ID_ENV]): InfraProbe[] {
  const dir = infraJournalDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: InfraProbe[] = [];
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const probe = JSON.parse(readFileSync(join(dir, name), 'utf8')) as InfraProbe;
      if (runId && runId.trim() !== '') {
        if (probe.runId !== runId) continue;
      } else if (now - Date.parse(probe.at) > STALE_AFTER_MS) {
        continue;
      }
      out.push(probe);
    } catch {
      /* A half-written or hand-edited record is not worth failing over. */
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Start a run with an empty journal. Called by the `verify` wrapper. */
export function clearInfraProbes(): void {
  try {
    rmSync(infraJournalDir(), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
