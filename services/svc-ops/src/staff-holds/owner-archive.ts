import { accountArchiveOf, accountStateSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { HoldOwnerArchive } from './desk.js';

const TIMEOUT_MS = 5000;

/**
 * Whether a hold's owner is archived, from svc-identity's `GET /internal/account/:userId` (`accountStateSchema`), asked
 * per confirm and kept nowhere. Every answer that is not that contract for that user is `unreadable`: no URL, no
 * credentials, a refusal, a timeout, another shape, another user, or a state without the field (`accountArchiveOf`).
 * None is taken as not archived.
 */
export function createHoldOwnerArchive(options: {
  identityUrl: string | undefined;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetcher?: typeof fetch;
}): HoldOwnerArchive {
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  let base: string | null = null;
  try {
    const url = new URL(options.identityUrl ?? '');
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) {
      base = url.href.replace(/\/$/, '');
    }
  } catch {
    base = null;
  }
  const sign = serviceCallSigner({ service: 'svc-ops', audience: 'svc-identity', legacySecret: options.secret ?? '', s2s: options.s2s });
  return {
    async archived(userId) {
      if (!base || !credentialed) return 'unreadable';
      const target = `${base}/internal/account/${encodeURIComponent(userId)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await (options.fetcher ?? fetch)(target, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
        if (!response.ok) return 'unreadable';
        const parsed = accountStateSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.userId.toLowerCase() !== userId.toLowerCase()) return 'unreadable';
        const archive = accountArchiveOf(parsed.data);
        return archive === 'unread' ? 'unreadable' : archive === 'archived';
      } catch {
        return 'unreadable';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
