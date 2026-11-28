import type { UserVenueAccount } from '@intafaced/venue-contracts';
import type { FetchLike } from './core.js';
import { HyperliquidReads } from './reads.js';

/**
 * A person's own-wallet reads of the Hyperliquid TEST network, made from their own browser.
 *
 * The venue limits each IP by the weight of its requests a minute (1,200). Read through the box's venue server, every
 * desk's per-wallet reads (fills, open orders, balances, positions) left from the box's one IP, so one trading tester
 * spent more than all of it. These reads are public, by address, with no key: made here, from the tester's own browser,
 * they count against the tester's IP. The answers are parsed by the same code the venue server parses them with
 * (`HyperliquidReads`), so the desk sees the same figures either way.
 *
 * It reads only: it holds no key and signs nothing. Its base URL is the test network's, fixed (`assertTestnetUrl`
 * refuses any other). The browser has no APP_ENV of its own: the app makes this reader only when svc-trade's door names
 * it (`walletReads` on its status), which it does only for the live test-network venue, itself refused outside APP_ENV
 * dev or test and the beta posture. Every figure is TEST.
 *
 * Reads are shared inside the page (`shareReads`): every part of a desk polling the same account's fills or balances is
 * one read, kept for a few seconds by its weight, so one person's open desk stays well inside their own IP's budget.
 * After the person's own signed action, `forgetOwnReads` drops what was kept, so the desk reads its result straight away.
 */
export interface HyperliquidWalletReadsOptions {
  /** The browser's own `fetch`. */
  readonly fetch: FetchLike;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  /** The HIP-3 perp DEXs read beside the main one, as the venue server names them; none when omitted. */
  readonly perpDexs?: readonly string[];
  /** Where a listing warning goes; the browser has no standard error. */
  readonly warn: (message: string) => void;
}

export class HyperliquidWalletReads extends HyperliquidReads {
  /** Every account this page has read, so an action of the person's drops all of their kept reads. */
  private readonly readUsers = new Set<string>();

  constructor(options: HyperliquidWalletReadsOptions) {
    super({
      // See above: the door names this reader only for its live TEST venue, which checked APP_ENV itself.
      appEnv: 'test',
      fetch: options.fetch,
      shareReads: true,
      warn: options.warn,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.perpDexs ? { perpDexs: options.perpDexs } : {}),
    });
  }

  /** The person signed an action through the door: every kept read of their accounts is read again. */
  forgetOwnReads(): void {
    this.forgetReads([...this.readUsers]);
  }

  protected override user(account: UserVenueAccount): string {
    const user = super.user(account);
    this.readUsers.add(user);
    return user;
  }
}
