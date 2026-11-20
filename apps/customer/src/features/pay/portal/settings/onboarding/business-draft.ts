import { useEffect, useRef, useState } from 'react';
import { useResource } from '../../../../../shared/resource';
import type { PortalApi } from '../../api';
import { emptyBusiness, type BusinessForm } from '../model';

/** How long the step waits after the last change before it saves; leaving the page saves at once. */
export const DRAFT_SAVE_DELAY_MS = 400;

/**
 * The business step's form, kept as a saved draft by svc-pay (J-merchant-02 #1): what was typed comes back after a
 * reload, leaving, signing out or another browser, until the account is opened. The browser stores nothing; the draft
 * is the service's. `unsaved` is true while a change has not been confirmed stored, so the leave warning stays on
 * exactly until it is. A draft that cannot be read leaves the form empty and working, as before drafts existed.
 */
export function useBusinessDraft(portal: PortalApi, enabled: boolean) {
  const draft = useResource(
    (s) => (enabled ? portal.onboardingDraft(s) : Promise.resolve({ ok: true as const, data: null })),
    `portal:onboarding-draft:${enabled ? 'open' : 'off'}`,
  );
  const [form, setFormState] = useState<BusinessForm>(emptyBusiness);
  const [unsaved, setUnsaved] = useState(false);
  const touched = useRef(false);
  const latest = useRef<{ fields: BusinessForm; seq: number } | null>(null);
  const sentSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Rises with every change and across reloads (time-based), so the service always keeps the newest save.
  const seq = useRef(Date.now());

  // The stored draft fills the form once, unless the person has already started typing.
  useEffect(() => {
    if (draft.resource.status !== 'ready' || touched.current || !draft.resource.data) return;
    setFormState({ ...emptyBusiness, ...draft.resource.data.fields });
  }, [draft.resource]);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = latest.current;
    if (!next || next.seq <= sentSeq.current) return;
    sentSeq.current = next.seq;
    void portal
      .saveOnboardingDraft(next.fields, next.seq)
      .then((result) => {
        if (result.ok && latest.current?.seq === next.seq) setUnsaved(false);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
    // flush reads only refs and the stable portal client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const setForm = (fields: BusinessForm) => {
    touched.current = true;
    setFormState(fields);
    if (!enabled) return;
    seq.current = Math.max(seq.current + 1, Date.now());
    latest.current = { fields, seq: seq.current };
    setUnsaved(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, DRAFT_SAVE_DELAY_MS);
  };

  return { form, setForm, unsaved };
}
