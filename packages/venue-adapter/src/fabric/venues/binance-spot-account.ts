import { readDecimal, requireCredentials, VenueUnavailableError } from '@intafaced/venue-contracts';
import type { AccountAdapter, VenueBalance, VenueCredentials, VenueDescriptor } from '@intafaced/venue-contracts';
import { fetchHttpPort, type HttpPort } from '../transport.js';
import { RateLimitGovernor } from '../rate-limit.js';
import { retryAfterFrom, signBinanceQuery } from './binance-spot-trade.js';

const REST_BASE = 'https://api.binance.com';
const RATE_LIMIT = { venueId: 'binance-spot', capacity: 6_000, windowMs: 60_000 } as const;

const VENUE: VenueDescriptor = {
  id: 'binance-spot',
  displayName: 'Binance Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

const TRANSFER_RAILS_REFUSED =
  'transferRails is not called: capital/config is a wallet-permission endpoint and connect keys must be trade-only (§27).';

export interface BinanceSpotAccountOptions {
  readonly http?: HttpPort;
  readonly restBase?: string;
  readonly clock?: () => number;
  readonly governor?: RateLimitGovernor;
}

export function mapBinanceSpotBalances(body: Record<string, unknown>, now: Date): VenueBalance[] {
  const rows = body.balances;
  if (!Array.isArray(rows)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'account balances is not an array');
  }
  const observedAt = now;
  return rows.map((row, i) => {
    if (!row || typeof row !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `balances[${i}] is not an object`);
    }
    const rec = row as Record<string, unknown>;
    const free = readDecimal(rec.free, VENUE.id, 'free');
    const used = readDecimal(rec.locked, VENUE.id, 'locked');
    return {
      venueId: VENUE.id,
      asset: String(rec.asset ?? ''),
      free,
      used,
      total: free + used,
      observedAt,
    };
  });
}

export class BinanceSpotAccount implements AccountAdapter {
  readonly venue = VENUE;
  readonly #credentials: VenueCredentials | null;
  readonly #http: HttpPort;
  readonly #restBase: string;
  readonly #clock: () => number;
  readonly #governor: RateLimitGovernor;

  constructor(credentials: VenueCredentials | null = null, options: BinanceSpotAccountOptions = {}) {
    if (credentials) requireCredentials(VENUE.id, 'construct', credentials);
    this.#credentials = credentials;
    this.#http = options.http ?? fetchHttpPort();
    this.#restBase = options.restBase ?? REST_BASE;
    this.#clock = options.clock ?? Date.now;
    this.#governor = options.governor ?? new RateLimitGovernor(RATE_LIMIT, this.#clock());
  }

  async balances(): Promise<VenueBalance[]> {
    const keys = requireCredentials(VENUE.id, 'balances', this.#credentials);
    const body = await this.#signedGet('/api/v3/account', { timestamp: String(this.#clock()), recvWindow: '5000' }, keys, 'balances');
    return mapBinanceSpotBalances(body, new Date(this.#clock()));
  }

  /**
   * Spot has no futures positions. An empty list here is honest, not "not built".
   */
  async positions(): Promise<[]> {
    requireCredentials(VENUE.id, 'positions', this.#credentials);
    return [];
  }

  async transferRails(): Promise<never> {
    requireCredentials(VENUE.id, 'transferRails', this.#credentials);
    throw new VenueUnavailableError(VENUE.id, 'not_ready', TRANSFER_RAILS_REFUSED);
  }

  /** User-data listen key (API-key header only — Binance does not HMAC this POST). */
  async createListenKey(): Promise<string> {
    const keys = requireCredentials(VENUE.id, 'createListenKey', this.#credentials);
    const post = this.#http.post?.bind(this.#http);
    if (!post) {
      throw new VenueUnavailableError(VENUE.id, 'not_ready', 'createListenKey: HTTP POST port is not wired');
    }
    this.#acquire('createListenKey');
    let response;
    try {
      response = await post(`${this.#restBase}/api/v3/userDataStream`, { headers: { 'X-MBX-APIKEY': keys.apiKey } });
    } catch (error) {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `POST /api/v3/userDataStream failed: ${String(error)}`);
    }
    this.#assertOk(response.status, response.body, 'createListenKey', response.header('Retry-After'));
    const key = (response.body as { listenKey?: unknown }).listenKey;
    if (typeof key !== 'string' || key.length === 0) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'createListenKey carried no listenKey');
    }
    return key;
  }

  async closeListenKey(listenKey: string): Promise<void> {
    const keys = requireCredentials(VENUE.id, 'closeListenKey', this.#credentials);
    const del = this.#http.delete?.bind(this.#http);
    if (!del) {
      throw new VenueUnavailableError(VENUE.id, 'not_ready', 'closeListenKey: HTTP DELETE port is not wired');
    }
    this.#acquire('closeListenKey');
    let response;
    try {
      response = await del(`${this.#restBase}/api/v3/userDataStream?listenKey=${encodeURIComponent(listenKey)}`, {
        headers: { 'X-MBX-APIKEY': keys.apiKey },
      });
    } catch (error) {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `DELETE /api/v3/userDataStream failed: ${String(error)}`);
    }
    this.#assertOk(response.status, response.body, 'closeListenKey', response.header('Retry-After'));
  }

  #acquire(operation: string): void {
    const decision = this.#governor.tryAcquire(1, this.#clock());
    if (!decision.admitted) {
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${decision.detail} (retry in ${decision.retryAfterMs}ms)`);
    }
    void operation;
  }

  async #signedGet(
    path: string,
    params: Record<string, string>,
    keys: VenueCredentials,
    operation: string,
  ): Promise<Record<string, unknown>> {
    this.#acquire(operation);
    const query = signBinanceQuery(params, keys.apiSecret);
    const url = `${this.#restBase}${path}?${query}`;
    let response;
    try {
      response = await this.#http.get(url, { headers: { 'X-MBX-APIKEY': keys.apiKey } });
    } catch (error) {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `GET ${path} failed: ${String(error)}`);
    }
    this.#assertOk(response.status, response.body, operation, response.header('Retry-After'));
    return response.body as Record<string, unknown>;
  }

  #assertOk(status: number, body: unknown, operation: string, retryAfterHeader: string | null): void {
    if (status === 429 || status === 418) {
      const retryAfterMs = retryAfterFrom(retryAfterHeader);
      this.#governor.observeVenueBackoff(retryAfterMs, `HTTP ${status}`, this.#clock());
      throw new VenueUnavailableError(
        VENUE.id,
        'rate_limited',
        `${VENUE.id} answered ${status}; backing off for ${retryAfterMs}ms`,
      );
    }
    if (status < 200 || status >= 300 || body === null || typeof body !== 'object') {
      const msg = body && typeof body === 'object' && 'msg' in body ? String((body as { msg: unknown }).msg) : `HTTP ${status}`;
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `${operation} ${msg}`);
    }
  }
}
