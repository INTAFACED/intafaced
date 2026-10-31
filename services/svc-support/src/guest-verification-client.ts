import {
  GUEST_VERIFICATION_PROCEDURES,
  serviceCallSigner,
  guestVerificationCodeSchema,
  guestVerificationEraseInputSchema,
  guestVerificationEraseReceiptSchema,
  guestVerificationGetInputSchema,
  guestVerificationReceiptSchema,
  guestVerificationSendInputSchema,
  type GuestVerificationCode,
  type GuestVerificationEraseReceipt,
  type GuestVerificationReceipt,
  type GuestVerificationSendInput,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';

/** svc-notify answered with one of the door's typed refusals. */
export class GuestVerificationRefusal extends Error {
  constructor(readonly code: GuestVerificationCode) {
    super(code);
    this.name = 'GuestVerificationRefusal';
  }
}

/** svc-notify's guest verification door (ADR 2026-10-22 §3.5), as svc-support calls it. */
export interface GuestVerificationDoor {
  /** False with no notify address or no credential: nothing can be mailed, and the guest path refuses `vendor.email`. */
  readonly configured: boolean;
  /** The receipt, a typed refusal (thrown), or null when no verified answer came back: never a reason to send again. */
  send(input: GuestVerificationSendInput): Promise<GuestVerificationReceipt | null>;
  get(businessKey: string): Promise<GuestVerificationReceipt | null>;
  erase(guestRequestId: string): Promise<GuestVerificationEraseReceipt | null>;
}

export const UNWIRED_GUEST_VERIFICATION: GuestVerificationDoor = {
  configured: false,
  send: async () => null,
  get: async () => null,
  erase: async () => null,
};

/** Exact-body, bounded call to the door on svc-support's own pairwise secret (or its per-service key). */
export function createGuestVerificationClient(options: {
  notifyUrl?: string;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): GuestVerificationDoor {
  let base: string | null = null;
  try {
    const url = new URL(options.notifyUrl ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/$/, '');
  } catch {
    /* No address: unconfigured. */
  }
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-notify', legacySecret: options.secret ?? '', s2s: options.s2s });
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  const configured = base !== null && credentialed;
  async function call(path: string, input: unknown): Promise<unknown> {
    if (!configured) return null;
    const body = JSON.stringify(input),
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, options.timeoutMs ?? 10_000);
    });
    const invoke = async () => {
      try {
        const target = `${base}/trpc/${path}`;
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
        const envelope: unknown = await response.json();
        if (!response.ok) {
          const code = guestVerificationCodeSchema.safeParse((envelope as { error?: { message?: unknown } } | null)?.error?.message);
          if (code.success) throw new GuestVerificationRefusal(code.data);
          return null;
        }
        return (envelope as { result?: { data?: unknown } } | null)?.result?.data ?? null;
      } catch (error) {
        if (error instanceof GuestVerificationRefusal) throw error;
        return null;
      }
    };
    try {
      return await Promise.race([invoke(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return {
    configured,
    async send(raw) {
      const input = guestVerificationSendInputSchema.parse(raw);
      const parsed = guestVerificationReceiptSchema.safeParse(await call(GUEST_VERIFICATION_PROCEDURES.send, input));
      return parsed.success && parsed.data.businessKey === input.businessKey ? parsed.data : null;
    },
    async get(businessKey) {
      const input = guestVerificationGetInputSchema.parse({ businessKey });
      const answer = await call(GUEST_VERIFICATION_PROCEDURES.get, input);
      const parsed = guestVerificationReceiptSchema.safeParse(answer);
      return parsed.success && parsed.data.businessKey === input.businessKey ? parsed.data : null;
    },
    async erase(guestRequestId) {
      const input = guestVerificationEraseInputSchema.parse({ guestRequestId });
      const parsed = guestVerificationEraseReceiptSchema.safeParse(await call(GUEST_VERIFICATION_PROCEDURES.erase, input));
      return parsed.success && parsed.data.guestRequestId.toLowerCase() === input.guestRequestId.toLowerCase() ? parsed.data : null;
    },
  };
}
