import { useEffect, useState } from 'react';
import { outreachPublicProblem, outreachPublicSettingsSchema } from '@intafaced/contracts/outreach-public';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { useApi } from '../session/session';

const publicSettings = contractProcedure('ops', 'outreach.publicSettings', { output: outreachPublicSettingsSchema });

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
    void readContract(api, publicSettings, undefined, { signal: controller.signal })
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
