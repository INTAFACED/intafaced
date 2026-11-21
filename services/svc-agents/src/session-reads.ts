/**
 * The session API's reads: every query under `session.`, `run.`, `usage.` and `log.` in this service's router, each with
 * one input its schema accepts, built from the ids of a person's own session, its first run and a second session.
 *
 * A key lacking `agents:read` must be refused on each of them (J-agents-12 #1 tries every one, from this list). The list
 * lives here, beside the router, so a new read fails `session-reads.test.ts` on the pull request that adds it, until it is
 * added below with an input. Before, the journey kept its own copy and a new read turned main red (#8495, fixed by #8507).
 */
export const SESSION_READ_PREFIXES = ['session', 'run', 'usage', 'log'] as const;

/** Is this router path one of the session API's reads? (its first segment is one of the four prefixes) */
export const isSessionRead = (path: string): boolean => (SESSION_READ_PREFIXES as readonly string[]).includes(path.split('.')[0] ?? '');

export interface SessionReadIds {
  /** The person's session A. */
  readonly sessionId: string;
  /** Session A's first run. */
  readonly runId: string;
  /** The request id that started that run. */
  readonly requestId: string;
  /** The person's session B. */
  readonly sessionB: string;
}

/** path → the input that read is called with (`undefined` for a read that takes none). */
export function sessionReadInputs(ids: SessionReadIds): Readonly<Record<string, unknown>> {
  return {
    'session.detail': { sessionId: ids.sessionId },
    'session.selected': undefined,
    'session.log': { sessionId: ids.sessionId, limit: 50 },
    'session.mine': { limit: 10 },
    'session.events': { sessionId: ids.sessionId, limit: 50 },
    'run.list': { sessionId: ids.sessionId, limit: 50 },
    'run.get': { runId: ids.runId },
    'run.events': { runId: ids.runId, limit: 50 },
    // One run's trace, by its session and the request that started it (J-agents-13).
    'run.trace': { sessionId: ids.sessionId, requestId: ids.requestId },
    // A background run is read by its own id; the scope is checked before any run is looked up.
    'run.background.get': { runId: ids.runId },
    'usage.current': { sessionId: ids.sessionB },
    'usage.summary': { limit: 50 },
    'log.mine': { limit: 50 },
    'log.count': {},
    // The whole log's export, a page at a time; refused before any page or audit row is written.
    'log.export': { limit: 50 },
  };
}
