import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';

// The visit of a signed share tag (RC-campaigns-06, J-campaigns-05 #2). `/invite?tag=<tag>` counts one visit per browser
// session per surface, then the invitation page works on the tag's link as it does on `?token=`. An edited tag is refused
// by the service (`share.tag_invalid`) and counts nothing.
// hand-declared-ok: svc-identity's affiliates procedures have no browser-safe schema in packages/contracts yet
const visitSchema = z.object({
  token: z.string().guid(),
  surface: z.enum(['promotion', 'card', 'token', 'strategy', 'receipt']),
  counted: z.boolean(),
  visits: z.number().int().nonnegative(),
});
export type ShareVisit =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; data: z.infer<typeof visitSchema> }
  | { status: 'failed'; failure: Extract<ApiResult<unknown>, { ok: false }> };

const SESSION_STORE = 'intafaced.share-session';

/** This browser session's own random key: the service counts a tag once per key. Not an identity and not a secret. */
export function shareSessionKey(): string {
  try {
    const held = sessionStorage.getItem(SESSION_STORE);
    if (held && /^[A-Za-z0-9_-]{16,64}$/.test(held)) return held;
    const made = crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(SESSION_STORE, made);
    return made;
  } catch {
    // No session storage: this page load is its own session.
    return crypto.randomUUID().replaceAll('-', '');
  }
}

export function useShareVisit(api: ApiClient, tag: string | null): ShareVisit {
  const [visit, setVisit] = useState<{ tag: string; value: ShareVisit } | null>(null);
  useEffect(() => {
    if (!tag) return;
    const controller = new AbortController();
    setVisit({ tag, value: { status: 'loading' } });
    void api
      .mutate('identity', 'affiliates.shareTagHit', { tag, sessionKey: shareSessionKey() }, visitSchema, { signal: controller.signal })
      .then((answer) => {
        if (controller.signal.aborted) return;
        setVisit({ tag, value: answer.ok ? { status: 'ready', data: answer.data } : { status: 'failed', failure: answer } });
      });
    return () => controller.abort();
  }, [api, tag]);
  if (!tag) return { status: 'none' };
  return visit?.tag === tag ? visit.value : { status: 'loading' };
}
