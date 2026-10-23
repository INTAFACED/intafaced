import { useEffect, useState } from 'react';
import { outreachPublicSettingsSchema } from '@intafaced/contracts/outreach-public';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { useApi } from '../session/session';
import { partnerEnquiryHref } from './public-pages';

const publicSettings = contractProcedure('ops', 'outreach.publicSettings', { output: outreachPublicSettingsSchema });

export type PartnerSettings = {
  /** `loading` until the outreach desk has answered; `unread` when it could not be asked (only the build address remains). */
  readonly status: 'loading' | 'ready' | 'unread';
  /** The partner enquiry form on the invitation site, or `null` when no join address is set. */
  readonly formHref: string | null;
  /** The programme terms as plain text, or `null` when none are published. */
  readonly terms: string | null;
};

/**
 * What the partner page shows (SP-pages-02). Once the founders have set anything on the outreach desk (revision above 0)
 * its join address decides, and a cleared one means no form link. The build-time `VITE_JOIN_URL` stands in only before
 * that, or when the desk could not be read. Terms come only from the desk.
 */
export function mergePartnerSettings(
  read: { ok: true; joinUrl: string | null; partnerTerms: string | null; revision: number } | { ok: false },
  build: string | undefined,
): PartnerSettings {
  const fallback = partnerEnquiryHref(build);
  if (!read.ok) return { status: 'unread', formHref: fallback, terms: null };
  const formHref = read.revision > 0 ? partnerEnquiryHref(read.joinUrl ?? undefined) : fallback;
  return { status: 'ready', formHref, terms: read.partnerTerms };
}

/** Reads `outreach.publicSettings` (public: a signed-out visitor reads it too) and merges it with the build address. */
export function usePartnerSettings(): PartnerSettings {
  const api = useApi();
  const build = import.meta.env.VITE_JOIN_URL as string | undefined;
  // Nothing is linked until the desk answers: the build address may be one the founders have since withdrawn.
  const [state, setState] = useState<PartnerSettings>({ status: 'loading', formHref: null, terms: null });
  useEffect(() => {
    const controller = new AbortController();
    void readContract(api, publicSettings, undefined, { signal: controller.signal })
      .then((answer) => {
        if (!controller.signal.aborted) setState(mergePartnerSettings(answer.ok ? { ok: true, ...answer.data } : { ok: false }, build));
      })
      .catch(() => {
        if (!controller.signal.aborted) setState(mergePartnerSettings({ ok: false }, build));
      });
    return () => controller.abort();
  }, [api, build]);
  return state;
}
