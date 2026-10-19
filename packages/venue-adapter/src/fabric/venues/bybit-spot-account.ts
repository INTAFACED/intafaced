import { readDecimal, requireCredentials, VenueUnavailableError } from '@intafaced/venue-contracts';
import type { AccountAdapter, VenueBalance, VenueCredentials, VenueDescriptor } from '@intafaced/venue-contracts';
import { fetchHttpPort, type HttpPort } from '../transport.js';
import { RateLimitGovernor } from '../rate-limit.js';
import { assertCredentialVenue } from './credential-guard.js';
import { signBybitV5 } from './bybit-spot-trade.js';

const REST_BASE = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const RATE_LIMIT = { venueId: 'bybit-spot', capacity: 600, windowMs: 5_000 } as const;
const IP_BACKOFF_MS = 600_000;
const RATE_LIMIT_RET_CODES = new Set([10_006, 10_018]);

const VENUE: VenueDescriptor = {
  id: 'bybit-spot',
  displayName: 'Bybit Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

const TRANSFER_RAILS_REFUSED =
  'transferRails is not called: Bybit coin-info / withdraw endpoints are wallet-scoped and connect keys must be trade-only (§27).';

function encodeQuery(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key]!)}`)
    .join('&');
}

export interface BybitSpotAccountOptions {
  readonly http?: HttpPort;
  readonly restBase?: string;
  readonly clock?: () => number;
  readonly governor?: RateLimitGovernor;
}

export function mapBybitSpotCoins(coin: unknown, now: Date): VenueBalance[] {
  if (!Array.isArray(coin)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'wallet-balance coin is not an array');
  }
  return coin.map((row, i) => {
    if (!row || typeof row !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `coin[${i}] is not an object`);
    }
    const rec = row as Record<string, unknown>;
    const total = readDecimal(rec.walletBalance, VENUE.id, 'walletBalance');
    const used = readDecimal(rec.locked ?? '0', VENUE.id, 'locked');
    // A blank field is absent: fall through to the next field, then to total - locked.
    const present = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== '';
    const freeRaw = [rec.availableToWithdraw, rec.free, rec.availableToTrade].find(present);
    const free = freeRaw === undefined ? total - used : readDecimal(freeRaw, VENUE.id, 'availableToWithdraw');
    const asset = String(rec.coin ?? '')
      .trim()
      .toUpperCase();
    if (!asset) throw new VenueUnavailableError(VENUE.id, 'malformed', `coin[${i}].coin is missing`);
    if (total < 0n || used < 0n || free < 0n) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `coin[${i}] contains a negative balance`);
    }
    if (free > total || used > total) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `coin[${i}] free/used exceeds walletBalance`);
    }
    return {
      venueId: VENUE.id,
      asset,
      free,
      used,
      total,
      observedAt: now,
    };
  });
}

export class BybitSpotAccount implements AccountAdapter {
  readonly venue = VENUE;
  readonly #credentials: VenueCredentials | null;
  readonly #http: HttpPort;
  readonly #restBase: string;
  readonly #clock: () => number;
  readonly #governor: RateLimitGovernor;

  constructor(credentials: VenueCredentials | null = null, options: BybitSpotAccountOptions = {}) {
    if (credentials) {
      assertCredentialVenue(VENUE.id, credentials);
      requireCredentials(VENUE.id, 'construct', credentials);
    }
    this.#credentials = credentials;
    this.#http = options.http ?? fetchHttpPort();
    this.#restBase = options.restBase ?? REST_BASE;
    this.#clock = options.clock ?? Date.now;
    this.#governor = options.governor ?? new RateLimitGovernor(RATE_LIMIT, this.#clock());
  }

  async balances(): Promise<VenueBalance[]> {
    const keys = requireCredentials(VENUE.id, 'balances', this.#credentials);
    const body = await this.#signedGet({ accountType: 'UNIFIED' }, keys);
    const list = (body.result as { list?: unknown } | undefined)?.list;
    if (!Array.isArray(list) || list.length === 0) {
      return [];
    }
    const first = list[0];
    if (!first || typeof first !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'wallet-balance list[0] is not an object');
    }
    return mapBybitSpotCoins((first as { coin?: unknown }).coin, new Date(this.#clock()));
  }

  async positions(): Promise<[]> {
    requireCredentials(VENUE.id, 'positions', this.#credentials);
    return [];
  }

  async transferRails(): Promise<never> {
    requireCredentials(VENUE.id, 'transferRails', this.#credentials);
    throw new VenueUnavailableError(VENUE.id, 'not_ready', TRANSFER_RAILS_REFUSED);
  }

  async #signedGet(params: Record<string, string>, keys: VenueCredentials): Promise<Record<string, unknown>> {
    const now = this.#clock();
    const decision = this.#governor.tryAcquire(1, now);
    if (!decision.admitted) {
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${decision.detail} (retry in ${decision.retryAfterMs}ms)`);
    }
    const timestamp = String(now);
    const payload = encodeQuery(params);
    const sign = signBybitV5(timestamp, keys.apiKey, RECV_WINDOW, keys.apiSecret, payload);
    const headers = {
      'X-BAPI-API-KEY': keys.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': sign,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    };
    const url = `${this.#restBase}/v5/account/wallet-balance?${payload}`;
    let response;
    try {
      response = await this.#http.get(url, { headers });
    } catch (error) {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `GET /v5/account/wallet-balance failed: ${String(error)}`);
    }
    if (response.status === 429 || response.status === 403) {
      this.#governor.observeVenueBackoff(IP_BACKOFF_MS, `HTTP ${response.status}`, this.#clock());
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${VENUE.id} answered ${response.status}`);
    }
    if (response.status < 200 || response.status >= 300 || response.body === null || typeof response.body !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `balances HTTP ${response.status}`);
    }
    const body = response.body as Record<string, unknown>;
    if (typeof body.retCode !== 'number') {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'balances answered with no numeric retCode');
    }
    if (RATE_LIMIT_RET_CODES.has(body.retCode)) {
      this.#governor.observeVenueBackoff(IP_BACKOFF_MS, `retCode ${body.retCode}`, this.#clock());
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${VENUE.id} answered retCode ${body.retCode}`);
    }
    if (body.retCode !== 0) {
      const retMsg = typeof body.retMsg === 'string' ? body.retMsg : '';
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `balances retCode ${body.retCode} (${retMsg})`);
    }
    return body;
  }
}
