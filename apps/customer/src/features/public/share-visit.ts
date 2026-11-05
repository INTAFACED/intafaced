import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';

// The visit of a signed share tag (RC-campaigns-06, J-campaigns-05 #2). `/invite?tag=<tag>` counts one visit per browser
// session per surface, then the invitation page works on the tag's link as it does on `?token=`. An edited tag is refused
// by the service (`share.tag_invalid`) and counts nothing.
// hand-declared-ok: svc-identity's affiliates procedures have no browser-safe schema in packages/contracts yet
/** The surfaces svc-identity signs tags for (its SHARE_SURFACES); one list for the browser, shared with the share sheet. */
export const SHARE_SURFACES = ['promotion', 'card', 'token', 'strategy', 'receipt'] as const;
export type ShareSurface = (typeof SHARE_SURFACES)[number];
const visitSchema = z.object({ token: z.string().guid(), surface: z.enum(SHARE_SURFACES), counted: z.boolean() });
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

/**
 * One request per tag and session for the life of the page: a remount, a session refresh or a new client reuses the
 * answer already asked for, so the first visit always reads "counted" and is never sent twice. Nothing is aborted, since
 * an aborted request may already have counted.
 */
const asked = new Map<string, Promise<ShareVisit>>();

export function useShareVisit(api: ApiClient, tag: string | null): ShareVisit {
  const client = useRef(api);
  client.current = api;
  const [visit, setVisit] = useState<{ tag: string; value: ShareVisit } | null>(null);
  useEffect(() => {
    if (!tag) return;
    let live = true;
    const sessionKey = shareSessionKey();
    const key = `${sessionKey}|${tag}`;
    let pending = asked.get(key);
    if (!pending) {
      pending = client.current
        .mutate('identity', 'affiliates.shareTagHit', { tag, sessionKey }, visitSchema)
        .then((answer): ShareVisit => (answer.ok ? { status: 'ready', data: answer.data } : { status: 'failed', failure: answer }));
      asked.set(key, pending);
    }
    void pending.then((value) => {
      if (live) setVisit({ tag, value });
    });
    return () => {
      live = false;
    };
  }, [tag]);
  if (!tag) return { status: 'none' };
  return visit?.tag === tag ? visit.value : { status: 'loading' };
}
