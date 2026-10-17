/**
 * Merchant Payments client.
 *
 * A mutating POST sends one Idempotency-Key for the whole call, including retries.
 * Retries are only for GET, HEAD, DELETE, or a call that carries an Idempotency-Key.
 * Delay is exponential with jitter, unless the response carries Retry-After.
 * Each attempt that is signed uses a new nonce and timestamp. The idempotency key
 * is not a nonce.
 *
 * Amount fields must be decimal strings. A JSON number is refused here.
 * There is no default host: a blank base URL or API key refuses.
 */
import { randomUUID } from 'node:crypto';
import { newRequestNonce, REQUEST_NONCE_HEADER, REQUEST_SIGNATURE_HEADER, REQUEST_TIMESTAMP_HEADER, signPayRequest } from './sign.js';

/** Extra attempts after the first. A client transport default, not a server limit. */
export const DEFAULT_MAX_RETRIES = 2;

export interface PayCallInput {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly maxRetries?: number;
}

export interface PayCall extends PayCallInput {
  readonly method: string;
  readonly path: string;
  readonly idempotency: boolean;
}

export interface PayTransportRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface PayTransportResponse {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type PayTransport = (input: PayTransportRequest) => Promise<PayTransportResponse>;

export interface PayClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly signingSecret?: string;
  readonly maxRetries?: number;
  readonly transport?: PayTransport;
  /** Milliseconds. Defaults to Date.now. */
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly newIdempotencyKey?: () => string;
  /** Test seam. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam. Defaults to Math.random. */
  readonly random?: () => number;
}

export interface PayResponse {
  readonly status: number;
  readonly body: unknown;
  readonly rawBody: string;
}

function retryBudget(value: number | undefined, fallback: number): number {
  const chosen = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(chosen) || chosen < 0) throw new Error('maxRetries must be a non-negative integer');
  return chosen;
}

function assertDecimalAmounts(value: unknown, path = 'body'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDecimalAmounts(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'amount' && typeof child === 'number') {
      throw new Error(`${path}.${key} must be a decimal string`);
    }
    assertDecimalAmounts(child, `${path}.${key}`);
  }
}

function fillPath(template: string, params: Readonly<Record<string, string>> | undefined): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (!value) throw new Error(`path parameter ${name} is not configured`);
    return encodeURIComponent(value);
  });
}

function requestUrl(baseUrl: string, path: string, query: PayCallInput['query']): URL {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\//, ''), base);
  if (query) {
    for (const key of Object.keys(query).sort()) {
      const value = query[key];
      if (value !== undefined) url.searchParams.append(key, value);
    }
  }
  return url;
}

function parseBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

async function fetchTransport(input: PayTransportRequest): Promise<PayTransportResponse> {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body ? Buffer.from(input.body) : undefined,
    redirect: 'manual',
  });
  const retryAfter = response.headers.get('retry-after');
  return {
    status: response.status,
    body: await response.text(),
    ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}),
  };
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

const SAFE_RETRY_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

/** Client transport ceiling so a Retry-After cannot stall the process. Not a server business TTL. */
const MAX_RETRY_DELAY_MS = 60_000;

function headerOf(headers: Readonly<Record<string, string>> | undefined, name: string): string {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return '';
}

function retryAfterMs(raw: string, nowMs: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return null;
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - nowMs), MAX_RETRY_DELAY_MS);
}

/** Half the exponential window plus a random half, so the wait grows and is not a fixed cadence. */
export function retryDelayMs(attempt: number, retryAfter: string, nowMs: number, random: () => number): number {
  const header = retryAfterMs(retryAfter, nowMs);
  if (header !== null) return header;
  const ceiling = 100 * 2 ** attempt;
  const jitter = Math.floor(Math.max(0, Math.min(0.999999, random())) * ceiling);
  return Math.floor(ceiling / 2) + jitter;
}

function mayRetry(method: string, idempotencyKey: string | undefined): boolean {
  if (SAFE_RETRY_METHODS.has(method.toUpperCase())) return true;
  return Boolean(idempotencyKey && idempotencyKey.trim());
}

export class PayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly signingSecret: string | undefined;
  private readonly maxRetries: number;
  private readonly transport: PayTransport;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly newIdempotencyKey: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: PayClientOptions) {
    if (!options.baseUrl?.trim()) throw new Error('Payments API base URL is not configured');
    if (!options.apiKey?.trim()) throw new Error('Payments API key is not configured');
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.signingSecret = options.signingSecret;
    this.maxRetries = retryBudget(options.maxRetries, DEFAULT_MAX_RETRIES);
    this.transport = options.transport ?? fetchTransport;
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? newRequestNonce;
    this.newIdempotencyKey = options.newIdempotencyKey ?? randomUUID;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async call(input: PayCall): Promise<PayResponse> {
    if (input.body !== undefined) assertDecimalAmounts(input.body);
    const path = fillPath(input.path, input.params);
    const url = requestUrl(this.baseUrl, path, input.query);
    const raw = input.body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(input.body));
    const idempotencyKey = input.idempotency ? (input.idempotencyKey ?? this.newIdempotencyKey()) : input.idempotencyKey;
    const attempts = retryBudget(input.maxRetries, this.maxRetries) + 1;
    let last: PayTransportResponse | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      };
      if (raw) headers['content-type'] = 'application/json';
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      if (this.signingSecret) {
        const signed = signPayRequest({
          secret: this.signingSecret,
          method: input.method,
          path: `${url.pathname}${url.search}`,
          timestamp: String(Math.floor(this.now() / 1000)),
          nonce: this.nonce(),
          body: raw ?? null,
        });
        headers[REQUEST_TIMESTAMP_HEADER] = signed.timestamp;
        headers[REQUEST_NONCE_HEADER] = signed.nonce;
        headers[REQUEST_SIGNATURE_HEADER] = signed.signature;
      }
      last = await this.transport({
        method: input.method.toUpperCase(),
        url: url.toString(),
        headers,
        ...(raw ? { body: raw } : {}),
      });
      if (!retryable(last.status) || !mayRetry(input.method, idempotencyKey) || attempt === attempts - 1) break;
      await this.sleep(retryDelayMs(attempt, headerOf(last.headers, 'retry-after'), this.now(), this.random));
    }
    if (!last) throw new Error('Payments API call did not run');
    return { status: last.status, body: parseBody(last.body), rawBody: last.body };
  }
}
