import { serviceAuthHeadersForBody } from './service-auth.js';
import {
  identityOperationDecisionInputSchema,
  identityOperationDecisionSchema,
  type IdentityOperationDecision,
  type IdentityOperationDecisionPort,
} from './operation-identity-decisions.js';

const uuidFields = new Set([
  'userId',
  'merchantId',
  'sessionId',
  'apiKeyId',
  'subAccountId',
  'parentGrantId',
  'actorMerchantId',
  'subjectMerchantId',
  'grantEventId',
]);
export function normalizeIdentityOperationInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeIdentityOperationInput);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        uuidFields.has(key) && typeof child === 'string' ? child.toLowerCase() : normalizeIdentityOperationInput(child),
      ]),
    );
  return value;
}
export function canonicalIdentityOperationIntent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalIdentityOperationIntent).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalIdentityOperationIntent(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** One bounded request. Unknown acceptance remains the owner's durable pending intent. */
export function createIdentityOperationDecisionClient(options: {
  owner: 'svc-trade' | 'svc-pay';
  identityUrl?: string;
  secret?: string;
  fetcher?: typeof fetch;
}): IdentityOperationDecisionPort {
  const unavailable: IdentityOperationDecision = { status: 'unavailable', code: 'authority.unavailable' };
  let endpoint: string | null = null;
  try {
    const url = new URL(options.identityUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/operationAdmission.decide`;
  } catch {
    /* Missing or invalid transport cannot admit an operation. */
  }
  return {
    async decide(raw) {
      if (endpoint === null || !options.secret || options.secret.length < 32) return unavailable;
      const parsed = identityOperationDecisionInputSchema.safeParse(normalizeIdentityOperationInput(raw));
      if (!parsed.success || parsed.data.intent.operation.service !== options.owner) return unavailable;
      const input = parsed.data,
        body = JSON.stringify(input),
        controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<IdentityOperationDecision>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(unavailable);
        }, 3000);
      });
      const call = async (): Promise<IdentityOperationDecision> => {
        try {
          const request = {
            method: 'POST',
            cache: 'no-store',
            redirect: 'error' as const,
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              ...serviceAuthHeadersForBody(options.owner, options.secret!, body),
            },
            body,
          };
          const response = await (options.fetcher ?? fetch)(endpoint, request);
          if (!response.ok) return unavailable;
          const envelope: unknown = await response.json();
          if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) return unavailable;
          const result = (envelope as { result?: { data?: unknown } }).result;
          const decision = identityOperationDecisionSchema.safeParse(result?.data);
          if (!decision.success) return unavailable;
          if (
            'intent' in decision.data &&
            canonicalIdentityOperationIntent(decision.data.intent) !== canonicalIdentityOperationIntent(input.intent)
          )
            return unavailable;
          return decision.data;
        } catch {
          return unavailable;
        }
      };
      try {
        return await Promise.race([call(), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
