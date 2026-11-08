import type { Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  decodeVenueWire,
  encodeVenueWire,
  type AsOf,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueAgent,
  type UserVenueBalance,
  type UserVenueDescriptor,
  type UserVenueFill,
  type UserVenueLeverage,
  type UserVenueMarket,
  type UserVenueOrder,
  type UserVenuePosition,
  type UserVenueWithdrawal,
  type VenueIntent,
  type VenueOrderPreview,
  type VenueRefusal,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';

/**
 * A `UserVenue` reached over HTTP: the TEST venue simulator's loopback server today
 * (packages/venue-sim/src/http-server.ts, started by tooling/scripts/local-test-venue.mjs).
 *
 * Every call has a timeout. What a lost answer means depends on the call:
 *
 *   · `submit` — once the request may have left, a timeout, a dropped connection, a 5xx or an answer that does not
 *     parse is `{ definite: false }`: the action may have landed, and the caller reads it back and never prepares it
 *     again (user-venue.ts). Only a refused connection (nothing was sent) is a definite `venue_down` refusal.
 *   · every other call sends nothing that moves value, so any failure is `VenueRefusalError('venue_down')`.
 *
 * A 422 is the venue's own typed refusal and is thrown as `VenueRefusalError`, as the in-process venue throws it.
 */

export interface HttpUserVenueOptions {
  readonly baseUrl: string;
  /** Per call, milliseconds. */
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

/** `GET /venue`: the descriptor and the EIP-712 chain id the venue's actions name. */
export interface HttpVenueInfo {
  readonly venue: UserVenueDescriptor;
  readonly chainId: number;
}

type Failure = { readonly kind: 'not_sent' | 'timeout' | 'connection_lost' | 'error_after_send'; readonly detail: string };

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

function causeCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Classify a fetch that threw: refused before sending, timed out, or lost after sending. */
export function classifyFetchFailure(err: unknown): Failure {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout', detail: 'no answer within the timeout' };
  const code = causeCode(err);
  if (code && NOT_SENT_CODES.has(code)) return { kind: 'not_sent', detail: `the connection was refused (${code})` };
  return { kind: 'connection_lost', detail: `the connection was lost (${code ?? (err as Error)?.message ?? 'unknown'})` };
}

export class HttpUserVenue implements UserVenue {
  private constructor(
    readonly venue: UserVenueDescriptor,
    readonly chainId: number,
    private readonly opts: HttpUserVenueOptions,
  ) {}

  /** Read the venue's descriptor (`GET /venue`) and build the client. Throws `VenueRefusalError('venue_down')` when unreachable. */
  static async connect(opts: HttpUserVenueOptions): Promise<HttpUserVenue> {
    const info = await HttpUserVenue.info(opts);
    return new HttpUserVenue(info.venue, info.chainId, opts);
  }

  static async info(opts: HttpUserVenueOptions): Promise<HttpVenueInfo> {
    const f = opts.fetch ?? fetch;
    const unknownVenue = { venueId: 'user-venue', code: 'venue_down' as const };
    let res: Response;
    try {
      res = await f(new URL('/venue', opts.baseUrl), { method: 'GET', signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
      throw new VenueRefusalError({ ...unknownVenue, detail: `the venue did not answer: ${classifyFetchFailure(err).detail}` });
    }
    let body: { venue?: UserVenueDescriptor; chainId?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new VenueRefusalError({ ...unknownVenue, detail: `the venue's descriptor did not parse (HTTP ${res.status})` });
    }
    const v = body.venue;
    if (
      !res.ok ||
      !v ||
      typeof v.id !== 'string' ||
      typeof v.displayName !== 'string' ||
      !['simulator', 'partner-sandbox', 'live'].includes(v.proofLevel) ||
      typeof body.chainId !== 'number' ||
      !Number.isSafeInteger(body.chainId)
    ) {
      throw new VenueRefusalError({ ...unknownVenue, detail: `the venue's descriptor is not usable (HTTP ${res.status})` });
    }
    return { venue: v, chainId: body.chainId };
  }

  private down(detail: string): VenueRefusalError {
    return new VenueRefusalError({ venueId: this.venue.id, code: 'venue_down', detail });
  }

  /** One POST. Returns the decoded body, or a failure saying how far the request got. Throws a 422 refusal. */
  private async post<T>(path: string, body: unknown): Promise<{ ok: true; value: T } | { ok: false; failure: Failure }> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(new URL(path, this.opts.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(encodeVenueWire(body)),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      return { ok: false, failure: classifyFetchFailure(err) };
    }
    let parsed: unknown;
    try {
      // The same timeout signal covers reading the body.
      parsed = await res.json();
    } catch (err) {
      // The answer came and does not parse: the venue erred after the request was sent.
      if (err instanceof SyntaxError) return { ok: false, failure: { kind: 'error_after_send', detail: 'the answer is not JSON' } };
      const failure = classifyFetchFailure(err);
      return { ok: false, failure: failure.kind === 'not_sent' ? { kind: 'connection_lost', detail: failure.detail } : failure };
    }
    if (res.status === 422) {
      const refusal = (parsed as { refusal?: VenueRefusal }).refusal;
      if (refusal && typeof refusal.code === 'string')
        throw new VenueRefusalError({ ...refusal, venueId: refusal.venueId ?? this.venue.id });
    }
    if (!res.ok) return { ok: false, failure: { kind: 'error_after_send', detail: `HTTP ${res.status}` } };
    try {
      return { ok: true, value: decodeVenueWire<T>(parsed) };
    } catch (err) {
      return { ok: false, failure: { kind: 'error_after_send', detail: `the answer did not parse: ${(err as Error).message}` } };
    }
  }

  /** A call that moves nothing: any failure is the venue being down. */
  private async read<T>(path: string, body: unknown): Promise<T> {
    const answer = await this.post<T>(path, body);
    if (!answer.ok) throw this.down(`${this.venue.displayName}: ${path}: ${answer.failure.detail}`);
    return answer.value;
  }

  markets(account: UserVenueAccount | null): Promise<AsOf<readonly UserVenueMarket[]>> {
    return this.read('/markets', { account });
  }

  preview(account: UserVenueAccount, intent: PlaceUserOrderIntent): Promise<AsOf<VenueOrderPreview>> {
    return this.read('/preview', { account, intent });
  }

  /** A lost prepare sends nothing to sign, so it is `venue_down` and safe to ask again. */
  prepare(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): Promise<PreparedVenueAction> {
    return this.read('/prepare', { account, signer, intent });
  }

  async submit(prepared: PreparedVenueAction, signature: VenueSignature): Promise<VenueSubmitOutcome> {
    const answer = await this.post<VenueSubmitOutcome>('/submit', { prepared, signature });
    if (answer.ok) {
      const o = answer.value as { definite?: unknown };
      if (typeof o.definite !== 'boolean') return { definite: false, reason: 'venue_error_after_send' };
      return answer.value;
    }
    switch (answer.failure.kind) {
      case 'not_sent':
        return {
          definite: true,
          accepted: false,
          refusal: { venueId: this.venue.id, code: 'venue_down', detail: `nothing was sent: ${answer.failure.detail}` },
          asOf: new Date(),
        };
      case 'timeout':
        return { definite: false, reason: 'timeout' };
      case 'connection_lost':
        return { definite: false, reason: 'connection_lost' };
      case 'error_after_send':
        return { definite: false, reason: 'venue_error_after_send' };
    }
  }

  balances(account: UserVenueAccount): Promise<AsOf<readonly UserVenueBalance[]>> {
    return this.read('/balances', { account });
  }

  openOrders(account: UserVenueAccount): Promise<AsOf<readonly UserVenueOrder[]>> {
    return this.read('/open-orders', { account });
  }

  orderByClientId(account: UserVenueAccount, venueClientOrderId: string): Promise<AsOf<UserVenueOrder | null>> {
    return this.read('/order-by-client-id', { account, venueClientOrderId });
  }

  fills(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueFill[]>> {
    return this.read('/fills', { account, since });
  }

  positions(account: UserVenueAccount): Promise<AsOf<readonly UserVenuePosition[]>> {
    return this.read('/positions', { account });
  }

  withdrawal(account: UserVenueAccount, nonce: string): Promise<AsOf<UserVenueWithdrawal | null>> {
    return this.read('/withdrawal', { account, nonce });
  }

  builderFeeApproval(account: UserVenueAccount, builder: string): Promise<AsOf<Amount>> {
    return this.read('/builder-fee-approval', { account, builder });
  }

  agents(account: UserVenueAccount): Promise<AsOf<readonly UserVenueAgent[]>> {
    return this.read('/agents', { account });
  }

  leverage(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueLeverage | null>> {
    return this.read('/leverage', { account, symbol });
  }
}
