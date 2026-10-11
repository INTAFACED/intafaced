import { readDecimal, requireCredentials, VenueUnavailableError } from '@intafaced/venue-contracts';
import type { AccountAdapter, VenueBalance, VenueCredentials, VenueDescriptor } from '@intafaced/venue-contracts';
import { fetchHttpPort, type HttpPort } from '../transport.js';
import { RateLimitGovernor } from '../rate-limit.js';
import { assertCredentialVenue } from './credential-guard.js';
import { signOkxRequest } from './okx-spot-trade.js';

const REST_BASE = 'https://www.okx.com';
const RATE_LIMIT = { venueId: 'okx-spot', capacity: 10, windowMs: 2_000 } as const;
const RATE_LIMIT_CODES = new Set(['50011']);

const VENUE: VenueDescriptor = {
  id: 'okx-spot',
  displayName: 'OKX Spot',
  kind: 'external-cex',
  sequencedDepth: true,
};

const TRANSFER_RAILS_REFUSED =
  'transferRails is not called: OKX asset/currencies is a wallet-permission surface and connect keys must be trade-only (§27).';

function requirePassphrase(keys: VenueCredentials): string {
  const passphrase = keys.passphrase;
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new VenueUnavailableError(VENUE.id, 'not_ready', 'passphrase required');
  }
  return passphrase;
}

export interface OkxSpotAccountOptions {
  readonly http?: HttpPort;
  readonly restBase?: string;
  readonly clock?: () => number;
  readonly governor?: RateLimitGovernor;
}

export function mapOkxSpotDetails(details: unknown, now: Date): VenueBalance[] {
  if (!Array.isArray(details)) {
    throw new VenueUnavailableError(VENUE.id, 'malformed', 'account balance details is not an array');
  }
  return details.map((row, i) => {
    if (!row || typeof row !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `details[${i}] is not an object`);
    }
    const rec = row as Record<string, unknown>;
    const free = readDecimal(rec.availBal, VENUE.id, 'availBal');
    const used = readDecimal(rec.frozenBal ?? '0', VENUE.id, 'frozenBal');
    const total = rec.eq === undefined || rec.eq === null || String(rec.eq) === '' ? free + used : readDecimal(rec.eq, VENUE.id, 'eq');
    const asset = String(rec.ccy ?? '')
      .trim()
      .toUpperCase();
    if (!asset) throw new VenueUnavailableError(VENUE.id, 'malformed', `details[${i}].ccy is missing`);
    if (free < 0n || used < 0n || total < 0n) {
      throw new VenueUnavailableError(VENUE.id, 'malformed', `details[${i}] contains a negative balance`);
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

export class OkxSpotAccount implements AccountAdapter {
  readonly venue = VENUE;
  readonly #credentials: VenueCredentials | null;
  readonly #http: HttpPort;
  readonly #restBase: string;
  readonly #clock: () => number;
  readonly #governor: RateLimitGovernor;

  constructor(credentials: VenueCredentials | null = null, options: OkxSpotAccountOptions = {}) {
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
    const passphrase = requirePassphrase(keys);
    const now = this.#clock();
    const decision = this.#governor.tryAcquire(1, now);
    if (!decision.admitted) {
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${decision.detail} (retry in ${decision.retryAfterMs}ms)`);
    }
    const requestPath = '/api/v5/account/balance';
    const timestamp = new Date(now).toISOString();
    const sign = signOkxRequest(keys.apiSecret, timestamp, 'GET', requestPath, '');
    const headers = {
      'OK-ACCESS-KEY': keys.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': passphrase,
    };
    let response;
    try {
      response = await this.#http.get(`${this.#restBase}${requestPath}`, { headers });
    } catch (error) {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `GET ${requestPath} failed: ${String(error)}`);
    }
    if (response.status === 429 || response.status === 418) {
      throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${VENUE.id} answered ${response.status}`);
    }
    if (response.status < 200 || response.status >= 300 || response.body === null || typeof response.body !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'unreachable', `balances answered ${response.status}`);
    }
    const envelope = response.body as Record<string, unknown>;
    if (envelope.code !== '0') {
      const code = envelope.code === undefined || envelope.code === null ? '' : String(envelope.code);
      const msg = typeof envelope.msg === 'string' ? envelope.msg : '';
      if (RATE_LIMIT_CODES.has(code)) {
        throw new VenueUnavailableError(VENUE.id, 'rate_limited', `${VENUE.id} answered code ${code} (${msg})`);
      }
      throw new VenueUnavailableError(VENUE.id, 'not_ready', `balances refused: code ${code || '(missing)'} (${msg || 'no message'})`);
    }
    const data = envelope.data;
    if (!Array.isArray(data) || data.length === 0) {
      return [];
    }
    const first = data[0];
    if (!first || typeof first !== 'object') {
      throw new VenueUnavailableError(VENUE.id, 'malformed', 'account balance data[0] is not an object');
    }
    return mapOkxSpotDetails((first as { details?: unknown }).details, new Date(this.#clock()));
  }

  async positions(): Promise<[]> {
    requireCredentials(VENUE.id, 'positions', this.#credentials);
    return [];
  }

  async transferRails(): Promise<never> {
    requireCredentials(VENUE.id, 'transferRails', this.#credentials);
    throw new VenueUnavailableError(VENUE.id, 'not_ready', TRANSFER_RAILS_REFUSED);
  }
}
