/**
 * TEST SUPPORT. The lost-reply and retry test for a money door.
 *
 * A "money door" is a function that moves value by posting to the ledger, possibly more than once. This replays it
 * against the shared fake ledger door (`./ledger-door.ts`) the ways a real network and a real deploy break it:
 *
 *  - duplicate: the caller runs again after it already succeeded;
 *  - lost ack: the post is booked but the caller never hears back, then the caller retries;
 *  - crash between posts: the process dies after post k, then a fresh run picks the work up.
 *
 * Every replay must end with exactly the book a single clean run produces: the same idempotency keys and the same
 * entries, once each. A key that differs between runs, a second booking, or a half-finished set left behind shows up
 * as a named failure. `describeMoneyDoor` turns each failure into a failing test.
 */
import { describe, expect, it } from 'vitest';
import { formatAmount } from '../money.js';
import type { MemoryLedger } from '../memory-ledger.js';
import { fakeLedgerDoor, type DoorCall, type DoorVerify } from './ledger-door.js';

export interface MoneyDoorScenario {
  /** What the door is called in test names. */
  readonly name: string;
  readonly secret: string;
  /** Pass `verifyServiceHeaders` from `@intafaced/contracts`. */
  readonly verify: DoorVerify;
  /** Book whatever the door needs to already exist (a deposit, a hold). Runs once per fresh ledger. */
  setup(ledger: MemoryLedger): Promise<void>;
  /** The door itself. It must send every ledger call through `fetchImpl`. Run again on retry. */
  run(fetchImpl: typeof fetch): Promise<unknown>;
  /** Extra check on the final book, for rules the shape comparison cannot see (a hold left stranded). */
  invariant?(ledger: MemoryLedger): void | Promise<void>;
}

export interface SagaFailure {
  readonly replay: string;
  readonly message: string;
}

const isPost = (input: string | URL | Request): boolean => new URL(String(input)).pathname === '/trpc/post';

/** The whole book as keys and entries without account ids (those differ between fresh ledgers). */
function shape(ledger: MemoryLedger): string[] {
  return ledger
    .journal()
    .map((tx) => {
      const entries = (tx.entries ?? [])
        .map((e) => `${e.assetId}:${e.direction}:${formatAmount(e.amount)}`)
        .sort()
        .join(',');
      return `${tx.idempotencyKey} ${entries}`;
    })
    .sort();
}

/** Runs the post, then loses the answer: the ledger booked it and the caller sees a network failure. */
function loseAckOnPost(inner: typeof fetch, n: number): typeof fetch {
  let seen = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    if (isPost(input) && ++seen === n) throw new TypeError('fetch failed');
    return res;
  }) as typeof fetch;
}

/** Lets the first `n` posts through, then every call fails as if the process had died. */
function crashAfterPosts(inner: typeof fetch, n: number): typeof fetch {
  let booked = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (booked >= n) throw new TypeError('process crashed');
    const res = await inner(input, init);
    if (isPost(input)) booked += 1;
    return res;
  }) as typeof fetch;
}

async function freshBook(scenario: MoneyDoorScenario, newLedger: () => MemoryLedger) {
  const ledger = newLedger();
  await scenario.setup(ledger);
  const calls: DoorCall[] = [];
  const healthy = fakeLedgerDoor(ledger, scenario.secret, scenario.verify, calls);
  return { ledger, calls, healthy };
}

/** Replays the door and returns what differs from one clean run. Empty means the door is safe to retry. */
export async function replayMoneyDoor(scenario: MoneyDoorScenario, newLedger: () => MemoryLedger): Promise<SagaFailure[]> {
  const failures: SagaFailure[] = [];
  const check = async (replay: string, ledger: MemoryLedger, expected: string[]) => {
    const got = shape(ledger);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      failures.push({
        replay,
        message: `book differs from one clean run:\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(got)}`,
      });
    }
    try {
      await scenario.invariant?.(ledger);
    } catch (err) {
      failures.push({ replay, message: `invariant: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const clean = await freshBook(scenario, newLedger);
  await scenario.run(clean.healthy);
  const expected = shape(clean.ledger);
  const posts = clean.calls.filter((c) => c.path === '/trpc/post').length;
  if (posts === 0) return [{ replay: 'clean run', message: 'the door posted nothing to the ledger, so there is nothing to replay' }];
  await check('clean run', clean.ledger, expected);

  const dup = await freshBook(scenario, newLedger);
  await scenario.run(dup.healthy);
  await scenario.run(dup.healthy);
  await check('duplicate request', dup.ledger, expected);

  for (let n = 1; n <= posts; n += 1) {
    const lost = await freshBook(scenario, newLedger);
    await scenario.run(loseAckOnPost(lost.healthy, n)).catch(() => undefined);
    await scenario.run(lost.healthy);
    await check(`lost ack on post ${n} of ${posts}, then retry`, lost.ledger, expected);
  }

  for (let n = 0; n < posts; n += 1) {
    const crashed = await freshBook(scenario, newLedger);
    await scenario.run(crashAfterPosts(crashed.healthy, n)).catch(() => undefined);
    await scenario.run(crashed.healthy);
    await check(`crash after ${n} of ${posts} posts, then a fresh run`, crashed.ledger, expected);
  }
  return failures;
}

/** Registers the replays as vitest tests. One call per money door. */
export function describeMoneyDoor(scenario: MoneyDoorScenario, newLedger: () => MemoryLedger): void {
  describe(`money door survives lost replies and retries — ${scenario.name}`, () => {
    it('ends every replay with the book of one clean run', async () => {
      const failures = await replayMoneyDoor(scenario, newLedger);
      expect(failures.map((f) => `${f.replay}: ${f.message}`)).toEqual([]);
    });
  });
}
