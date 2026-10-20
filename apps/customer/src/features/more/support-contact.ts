import { useEffect, useState } from 'react';
import { supportContactChannelsSchema } from '@intafaced/contracts/support-contact';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { useApi } from '../session/session';
import { supportEmail } from './support-desk';

const contactChannels = contractProcedure('support', 'contactChannels', { output: supportContactChannelsSchema });

/**
 * The address owned by the build, or `null` while none is published. `VITE_SUPPORT_EMAIL` is read at call time so a screen
 * never holds a stale answer. There is no fallback address: every reader says "not set".
 */
export function supportContactEmail(): string | null {
  return supportEmail(import.meta.env.VITE_SUPPORT_EMAIL as string | undefined);
}

export type SupportContact = {
  /** `loading` until the support service has answered; `unread` when it could not be asked (only the build address remains). */
  readonly status: 'loading' | 'ready' | 'unread';
  readonly email: string | null;
  readonly phone: string | null;
  readonly chatHours: string | null;
};

/**
 * The details to show a visitor. The owner-set value from the support service wins; the build-time address is used only
 * when the service holds none or could not be read. A value that is not an address is "not set", never a guess.
 */
export function mergeSupportContact(
  read: { ok: true; email: string | null; phone: string | null; chatHours: string | null } | { ok: false },
  build: string | null,
): SupportContact {
  if (!read.ok) return { status: 'unread', email: build, phone: null, chatHours: null };
  return { status: 'ready', email: supportEmail(read.email ?? undefined) ?? build, phone: read.phone, chatHours: read.chatHours };
}

/** Reads `support.contactChannels` (public: a signed-out visitor reads it too) and merges it with the build address. */
export function useSupportContact(): SupportContact {
  const api = useApi();
  const [state, setState] = useState<SupportContact>({ status: 'loading', email: supportContactEmail(), phone: null, chatHours: null });
  useEffect(() => {
    const controller = new AbortController();
    void readContract(api, contactChannels, undefined, { signal: controller.signal })
      .then((answer) => {
        if (controller.signal.aborted) return;
        setState(mergeSupportContact(answer.ok ? { ok: true, ...answer.data } : { ok: false }, supportContactEmail()));
      })
      .catch(() => {
        if (!controller.signal.aborted) setState(mergeSupportContact({ ok: false }, supportContactEmail()));
      });
    return () => controller.abort();
  }, [api]);
  return state;
}
