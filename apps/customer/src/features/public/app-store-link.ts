import { useEffect, useState } from 'react';
import { outreachPublicProblem } from '@intafaced/contracts/outreach-public';
import { OPS_OUTREACH_PUBLIC_SETTINGS } from '@intafaced/contracts/ops-public-procedures';
import { useApi } from '../session';

/**
 * The store link /app shows (SP-pages-03): the founders' https store address from the outreach desk, or `null` when none is
 * set, the desk has not answered yet, or it could not be read. Nothing is built in, so `null` means the page says there is
 * no store app. A value the contract would refuse is never linked.
 */
export function appStoreHref(read: { ok: true; appStoreUrl: string | null } | { ok: false }): string | null {
  if (!read.ok || read.appStoreUrl === null) return null;
  return outreachPublicProblem('appStoreUrl', read.appStoreUrl) === null ? read.appStoreUrl.trim() : null;
}

/** Reads `outreach.publicSettings` (public: a signed-out visitor reads it too) for the store link. */
export function useAppStoreLink(): string | null {
  const api = useApi();
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .call(OPS_OUTREACH_PUBLIC_SETTINGS, undefined, { signal: controller.signal })
      .then((answer) => {
        if (!controller.signal.aborted)
          setHref(appStoreHref(answer.ok ? { ok: true, appStoreUrl: answer.data.appStoreUrl } : { ok: false }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setHref(null);
      });
    return () => controller.abort();
  }, [api]);
  return href;
}
