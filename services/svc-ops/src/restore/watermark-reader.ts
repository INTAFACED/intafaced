import {
  restoreWatermarkReadSchema,
  serviceCallSigner,
  type RestoreService,
  type RestoreWatermarkRead,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { OPS_RESTORE_WATERMARK_UNAVAILABLE } from '../codes.js';

export type WatermarkReadResult = { ok: true; value: RestoreWatermarkRead } | { ok: false; code: string; message: string };

export interface WatermarkReader {
  read(service: RestoreService): Promise<WatermarkReadResult>;
}

const TIMEOUT_MS = 5000;

/** Where each service answers its `restore.watermark.read`. Ledger is a tRPC-style door; the rest are internal routes. */
const DOORS: Record<
  RestoreService,
  { audience: 'svc-ledger' | 'svc-identity' | 'svc-bank' | 'svc-pay'; method: 'GET' | 'POST'; path: string }
> = {
  ledger: { audience: 'svc-ledger', method: 'POST', path: '/trpc/restoreWatermark' },
  identity: { audience: 'svc-identity', method: 'GET', path: '/internal/restore/watermark' },
  bank: { audience: 'svc-bank', method: 'POST', path: '/internal/restore/watermark' },
  pay: { audience: 'svc-pay', method: 'POST', path: '/internal/restore/watermark' },
};

/** An internal service base URL: http(s), no credentials, query or fragment, no trailing slash. Null otherwise. */
export function baseOf(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Reads the four services' watermarks. Every outcome that is not a contract-shaped answer from the right service is a
 * typed unavailable that names the service: a missing URL, a refusal, a timeout, a malformed body and an answer from
 * another service. None is turned into a position.
 */
export function createWatermarkReader(options: {
  urls: Partial<Record<RestoreService, string | undefined>>;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetcher?: typeof fetch;
}): WatermarkReader {
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  return {
    async read(service) {
      const door = DOORS[service];
      const unavailable = (message: string): WatermarkReadResult => ({
        ok: false,
        code: OPS_RESTORE_WATERMARK_UNAVAILABLE,
        message: `${door.audience}: ${message}`,
      });
      const base = baseOf(options.urls[service]);
      if (!base || !credentialed) return unavailable('this service is not wired here, so no position was read.');
      const sign = serviceCallSigner({ service: 'svc-ops', audience: door.audience, legacySecret: options.secret ?? '', s2s: options.s2s });
      const body = door.method === 'POST' ? '{}' : '';
      const target = `${base}${door.path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await (options.fetcher ?? fetch)(target, {
          method: door.method,
          redirect: 'error',
          signal: controller.signal,
          // The GET carries the content type too, so the signed context equals what goes on the wire.
          headers: {
            'content-type': 'application/json',
            ...sign(body, { method: door.method, url: new URL(target), contentType: 'application/json' }),
          },
          ...(door.method === 'POST' ? { body } : {}),
        });
        if (!response.ok) return unavailable(`refused the watermark read (${response.status}).`);
        const parsed = restoreWatermarkReadSchema.safeParse(await response.json());
        if (!parsed.success) return unavailable('answered in a shape this service does not read.');
        if (parsed.data.service !== service) return unavailable(`answered for ${parsed.data.service}, not ${service}.`);
        return { ok: true, value: parsed.data };
      } catch {
        return unavailable('did not answer the watermark read.');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
