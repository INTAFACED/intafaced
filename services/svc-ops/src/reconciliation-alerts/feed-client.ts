import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import {
  reconciliationEvaluationFeedSchema,
  type ReconciliationEvaluationFeed,
  type ReconciliationEvaluationFeedInput,
} from '@intafaced/contracts/ledger-reconciliation';

/** A page of the ledger's settled evaluations, or why it could not be had. Never an empty page in place of a failure. */
export type EvaluationFeedRead = { ok: true; value: ReconciliationEvaluationFeed } | { ok: false; message: string };

export interface EvaluationFeedPort {
  readonly configured: boolean;
  read(input: ReconciliationEvaluationFeedInput): Promise<EvaluationFeedRead>;
}

const TIMEOUT_MS = 5000;

/**
 * Reads svc-ledger's `reconciliationEvaluations` door, a read the ledger opens to svc-ops alone. A missing URL, a
 * refusal, a timeout, a malformed body and a page that does not follow the asked cursor each come back as a failure, so
 * the alert list says it could not read rather than that nothing failed.
 */
export function createEvaluationFeedClient(options: {
  ledgerUrl?: string;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetcher?: typeof fetch;
}): EvaluationFeedPort {
  let base: string | null = null;
  try {
    const url = new URL(options.ledgerUrl ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/$/, '');
  } catch {
    /* Missing transport is explicitly unconfigured. */
  }
  const sign = serviceCallSigner({ service: 'svc-ops', audience: 'svc-ledger', legacySecret: options.secret ?? '', s2s: options.s2s });
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  const configured = base !== null && credentialed;
  const unavailable = (message: string): EvaluationFeedRead => ({ ok: false, message });

  return {
    configured,
    async read(input) {
      if (!configured) return unavailable('The ledger is not wired to this service. No evaluation was read or invented.');
      const body = JSON.stringify(input);
      const target = `${base}/trpc/reconciliationEvaluations`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await (options.fetcher ?? fetch)(target, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body,
        });
        if (!response.ok) return unavailable(`The ledger refused the evaluation read (${response.status}).`);
        const parsed = reconciliationEvaluationFeedSchema.safeParse(await response.json());
        if (!parsed.success) return unavailable('The ledger answered evaluations in a shape this service does not read.');
        if (parsed.data.evaluations.length > input.limit) return unavailable('The ledger answered more evaluations than asked.');
        if (!followsCursor(input.after, parsed.data)) {
          return unavailable('The ledger answered evaluations that do not follow the cursor asked.');
        }
        return { ok: true, value: parsed.data };
      } catch {
        return unavailable('The ledger did not answer the evaluation read.');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type Cursor = { finishedAt: string; id: string };

/** Microseconds since the epoch, so two runs finished in the same millisecond still order as the ledger orders them. */
export function micros(iso: string): bigint {
  const fraction = (/\.(\d+)/.exec(iso)?.[1] ?? '').slice(0, 6);
  const sub = fraction ? BigInt(fraction) * 10n ** BigInt(6 - fraction.length) : 0n;
  return BigInt(Date.parse(iso.replace(/\.\d+/, ''))) * 1000n + sub;
}

/** Whether cursor `a` comes after `b` in the ledger's (finishedAt, id) order. */
export function after(a: Cursor, b: Cursor): boolean {
  const ta = micros(a.finishedAt);
  const tb = micros(b.finishedAt);
  return ta !== tb ? ta > tb : a.id > b.id;
}

/** Every evaluation is strictly after the cursor asked, the page is in order, and `next` is its last row. */
function followsCursor(asked: Cursor | null, feed: ReconciliationEvaluationFeed): boolean {
  let previous = asked;
  for (const evaluation of feed.evaluations) {
    const row = { finishedAt: evaluation.finishedAt, id: evaluation.run.id };
    if (previous && !after(row, previous)) return false;
    previous = row;
  }
  if (feed.evaluations.length === 0) return feed.next === null ? asked === null : asked !== null && sameCursor(feed.next, asked);
  return feed.next !== null && previous !== null && sameCursor(feed.next, previous);
}

function sameCursor(a: Cursor, b: Cursor): boolean {
  return a.finishedAt === b.finishedAt && a.id === b.id;
}
