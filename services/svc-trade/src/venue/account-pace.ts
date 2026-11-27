/**
 * THE ACCOUNT PACE: how many accounts a background reader reads a minute, so what it spends at a venue that
 * limits each IP by weight a minute (Hyperliquid: 1,200, shared by everything on the box) stays the same however many
 * accounts there are. With more accounts each one is read less often; the box's weight does not grow.
 *
 * Each `take` hands out the accounts that are due, in a fixed order (by key) that carries on from the last account read,
 * and says when it came back round to the start: a full round reads every account once. Reads earn credit at `perMinute`
 * accounts a minute, held up to one minute's worth, so a reader that ticks often reads a few accounts each tick and a
 * quiet minute does not turn into a burst. `perMinute` null reads every account on every take, as before.
 */
export class AccountPace {
  private credit: number;
  private lastMs: number | null = null;
  private after: string | null = null;
  private roundBegan: Date | null = null;
  private roundClean = true;
  /** The keys handed out in the current round. */
  private roundKeys = new Set<string>();

  constructor(
    private readonly perMinute: number | null,
    private readonly now: () => Date,
  ) {
    if (perMinute !== null && !(Number.isSafeInteger(perMinute) && perMinute > 0)) {
      throw new Error(`an account pace is a whole number of accounts a minute above zero, not ${perMinute}`);
    }
    this.credit = perMinute ?? 0;
  }

  /**
   * The accounts to read now, in key order from the one after the last read, never past the end of a round. `round.ends`
   * is true when this slice reaches the last account, so every account has been handed out once since `round.began`.
   */
  take<T>(
    accounts: readonly T[],
    keyOf: (a: T) => string,
  ): { readonly due: T[]; readonly round: { readonly began: Date; readonly ends: boolean } } {
    const now = this.now();
    const sorted = [...accounts].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    let n = sorted.length;
    if (this.perMinute !== null) {
      const nowMs = now.getTime();
      if (this.lastMs !== null) this.credit = Math.min(this.perMinute, this.credit + ((nowMs - this.lastMs) * this.perMinute) / 60_000);
      this.lastMs = nowMs;
      n = Math.floor(this.credit);
    }
    const after = this.after;
    const next = after === null ? 0 : sorted.findIndex((a) => keyOf(a) > after);
    // A round starts at the first account, also when the last account read is gone and none comes after it.
    const from = next < 0 ? 0 : next;
    if (from === 0 && (n > 0 || this.roundBegan === null)) {
      this.roundBegan = now;
      this.roundClean = true;
      this.roundKeys = new Set();
    }
    const due = sorted.slice(from, from + n);
    if (this.perMinute !== null) this.credit -= due.length;
    for (const a of due) this.roundKeys.add(keyOf(a));
    const ends = from + due.length >= sorted.length;
    // An account that joined behind the current position was not read this round: the round is not a complete one.
    if (ends && sorted.some((a) => !this.roundKeys.has(keyOf(a)))) this.roundClean = false;
    if (ends) this.after = null;
    else {
      const last = due.at(-1);
      if (last !== undefined) this.after = keyOf(last);
    }
    return { due, round: { began: this.roundBegan ?? now, ends } };
  }

  /** An account of the current round was not read: the round is not a complete one. */
  spoilRound(): void {
    this.roundClean = false;
  }

  /** True while every account handed out in the current round was read, and, at its end, every account was handed out. */
  get roundIsClean(): boolean {
    return this.roundClean;
  }
}

/** An account pace from its raw setting: blank reads every account each tick; otherwise a whole number above zero. */
export function accountPaceSetting(raw: string, name: string): number | null {
  const v = raw.trim();
  if (v === '') return null;
  if (!/^\d+$/.test(v) || Number(v) < 1 || !Number.isSafeInteger(Number(v))) {
    throw new Error(`${name} must be blank (every account each tick) or a whole number of accounts a minute above zero, not "${raw}"`);
  }
  return Number(v);
}
