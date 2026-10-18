import { isPublishedConnectionCeiling } from './max-connections.js';

const WINDOW_MS = 60_000;

/**
 * Owner-published cap on new public websocket connections in one minute.
 * Blank is unpublished: admit everything, and do not invent 30.
 * A refusal does not close connections already admitted.
 */
export class NewConnectionWindow {
  readonly #openedAt: number[] = [];

  constructor(
    private readonly cap: number | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  admit(now = this.clock()): boolean {
    if (!isPublishedConnectionCeiling(this.cap)) return true;
    const cutoff = now - WINDOW_MS;
    while (this.#openedAt.length > 0 && this.#openedAt[0]! <= cutoff) this.#openedAt.shift();
    if (this.#openedAt.length >= this.cap) return false;
    this.#openedAt.push(now);
    return true;
  }
}
