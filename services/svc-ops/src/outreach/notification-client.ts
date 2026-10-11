import {
  serviceAuthHeadersForBody,
  guestNotificationSendInputSchema,
  guestNotificationReceiptSchema,
  guestNotificationGetInputSchema,
  guestNotificationEraseInputSchema,
  guestNotificationEraseReceiptSchema,
  guestNotificationCodeSchema,
  type GuestNotificationSendInput,
  type GuestNotificationReceipt,
} from '@intafaced/contracts';

export class OutreachNotificationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface OutreachNotificationPort {
  readonly configured: boolean;
  send(input: GuestNotificationSendInput): Promise<GuestNotificationReceipt | null>;
  get(businessKey: string): Promise<GuestNotificationReceipt | null>;
  eraseSubmission(input: {
    requestId: string;
    submissionId: string;
  }): Promise<{ requestId: string; submissionId: string; erasedCount: number; erasedAt: string } | null>;
}

/** Exact-body, bounded ops-only ingress. Null means no verified receipt, never no send. */
export function createOutreachNotificationClient(options: {
  notifyUrl?: string;
  secret?: string;
  fetcher?: typeof fetch;
}): OutreachNotificationPort {
  let base: string | null = null;
  try {
    const url = new URL(options.notifyUrl ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/$/, '');
  } catch {
    /* Missing transport is explicitly unconfigured. */
  }
  const configured = base !== null && Boolean(options.secret && options.secret.length >= 32);
  async function call(procedure: string, input: unknown): Promise<unknown> {
    if (!configured) return null;
    const body = JSON.stringify(input),
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, 3000);
    });
    const invoke = async () => {
      try {
        const request = {
          method: 'POST',
          cache: 'no-store',
          redirect: 'error' as const,
          signal: controller.signal,
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-ops', options.secret!, body) },
          body,
        };
        const response = await (options.fetcher ?? fetch)(`${base}/trpc/guestNotifications.${procedure}`, request);
        const envelope: unknown = await response.json();
        if (!response.ok) {
          const code = guestNotificationCodeSchema.safeParse((envelope as { error?: { message?: unknown } } | null)?.error?.message);
          if (code.success) throw new OutreachNotificationError(code.data);
          return null;
        }
        if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) return null;
        const result = (envelope as { result?: { data?: unknown } }).result;
        return result?.data ?? null;
      } catch (error) {
        if (error instanceof OutreachNotificationError) throw error;
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
      const input = guestNotificationSendInputSchema.parse(raw);
      const parsed = guestNotificationReceiptSchema.safeParse(await call('send', input));
      return parsed.success && parsed.data.businessKey === input.businessKey ? parsed.data : null;
    },
    async get(businessKey) {
      const input = guestNotificationGetInputSchema.parse({ businessKey });
      const parsed = guestNotificationReceiptSchema.safeParse(await call('get', input));
      return parsed.success && parsed.data.businessKey === input.businessKey ? parsed.data : null;
    },
    async eraseSubmission(raw) {
      const input = guestNotificationEraseInputSchema.parse(raw);
      const parsed = guestNotificationEraseReceiptSchema.safeParse(await call('eraseSubmission', input));
      return parsed.success &&
        parsed.data.requestId.toLowerCase() === input.requestId.toLowerCase() &&
        parsed.data.submissionId.toLowerCase() === input.submissionId.toLowerCase()
        ? parsed.data
        : null;
    },
  };
}
