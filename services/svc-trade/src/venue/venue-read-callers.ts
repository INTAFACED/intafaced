/**
 * WHO IN svc-trade READS THE VENUE, A MINUTE AT A TIME: each read svc-trade sends to a venue, counted by the read and the
 * line of svc-trade code that asked for it, and logged once a minute as `trade.venue_reads_minute`.
 *
 * The venue's own counter (`hl.venue_weight_minute`) says what left the box and for how many accounts, never who asked:
 * this names each reader, so a background reader whose spend grows with the account count is found by name.
 *
 * The caller is read from the call's stack: the first frame in svc-trade's own code that is not the venue's HTTP client.
 * A read made from a route handler names that handler's line. Reads only: it counts and logs, and changes no answer.
 */

/** The svc-trade frames that are the venue's plumbing, not its callers. */
const PLUMBING = /\/venue\/(http-user-venue|venue-read-callers)\.[jt]s:/;
const OWN_CODE = /\/svc-trade\/(?:dist|src)\/(.+?\.[jt]s):(\d+):\d+/;

/** The svc-trade line that made this call, as `venue/balance-watch.js:221`, or `unknown` when the stack names none. */
export function readCaller(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    if (PLUMBING.test(line)) continue;
    const m = OWN_CODE.exec(line);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return 'unknown';
}

/** One minute's reads, named by its start (UTC): for each caller, how many of each read it sent. */
export interface VenueReadsMinute {
  readonly minute: string;
  readonly reads: number;
  readonly byCaller: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export class VenueReadCallers {
  private current: { startMs: number; byCaller: Map<string, Map<string, number>> } | null = null;

  constructor(
    private readonly now: () => Date,
    private readonly emit: (minute: VenueReadsMinute) => void,
  ) {}

  /** `HttpUserVenue`'s `onRead`, passed as it is so no other frame stands between the read and its caller. */
  readonly onRead = (path: string): void => this.count(path);

  /** Counts one read, its caller read from `stack` (the call's own stack by default); tells `emit` the last minute's reads once a new minute starts. */
  count(read: string, stack: string | undefined = callStack()): void {
    const startMs = Math.floor(this.now().getTime() / 60_000) * 60_000;
    if (this.current === null || this.current.startMs !== startMs) {
      if (this.current !== null) this.emit(summary(this.current));
      this.current = { startMs, byCaller: new Map() };
    }
    const caller = readCaller(stack);
    const row = this.current.byCaller.get(caller) ?? new Map<string, number>();
    row.set(read, (row.get(read) ?? 0) + 1);
    this.current.byCaller.set(caller, row);
  }
}

function summary(m: { startMs: number; byCaller: Map<string, Map<string, number>> }): VenueReadsMinute {
  const total = (row: Map<string, number>) => [...row.values()].reduce((a, b) => a + b, 0);
  const byCaller: Record<string, Record<string, number>> = {};
  let reads = 0;
  for (const [caller, row] of [...m.byCaller].sort(([, a], [, b]) => total(b) - total(a))) {
    byCaller[caller] = Object.fromEntries([...row].sort(([, a], [, b]) => b - a));
    reads += total(row);
  }
  return { minute: new Date(m.startMs).toISOString(), reads, byCaller };
}

/** The stack of the call being made now, with room for the frames between the read and its caller. */
function callStack(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}
