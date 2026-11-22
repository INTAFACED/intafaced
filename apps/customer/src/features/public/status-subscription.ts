import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDataEnv } from '../../data/hooks';
import { writeContract, type ContractData } from '../../shared/contract-call';
import type { ApiResult } from '../../shared/api';
import { statusPageFetcher, statusSubscriptionGet, statusSubscriptionUpdate, statusUnsubscribe, type StatusPage } from './status';
import { statusSubscribeCopy } from './status-subscribe-copy';

/**
 * What the status mail link pages share (SP-status-04): /status/confirm and /status/unsubscribe (StatusSubscriptionFlow.tsx)
 * and /status/manage (StatusSubscription.tsx). The pages draw; this file reads the link and holds the manage form's work.
 */
export type View = ContractData<typeof statusSubscriptionGet>;
export type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
export type T = ReturnType<typeof statusSubscribeCopy.useCopy>['t'];

export const DEAD = new Set(['status.subscription_link_invalid', 'status.subscriber_unknown']);

/** The link's token, read once; it leaves the address bar once read. */
export function useLinkToken(): string {
  const token = useRef(new URLSearchParams(location.search).get('token')?.trim() ?? '').current;
  useEffect(() => {
    if (location.search) history.replaceState(history.state, '', location.pathname);
  }, []);
  return token;
}

/** The manage form's state and its two writes: save the choices, or leave. */
export function useManageSubscription({ token, view, onChange }: { token: string; view: View; onChange: (view: View) => void }) {
  const { api } = useDataEnv();
  const [components, setComponents] = useState<StatusPage['components']>([]);
  const [all, setAll] = useState(view.componentIds === null);
  const [picked, setPicked] = useState<string[]>(view.componentIds ?? []);
  const [webhook, setWebhook] = useState(view.webhookUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void statusPageFetcher(api)(controller.signal).then((answer) => answer.ok && setComponents(answer.data.components));
    return () => controller.abort();
  }, [api]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setRefusal(null);
    const answer = await writeContract(api, statusSubscriptionUpdate, {
      token,
      componentIds: all ? null : picked,
      webhookUrl: webhook.trim() === '' ? null : webhook.trim(),
    });
    setBusy(false);
    if (answer.ok) {
      onChange(answer.data);
      setSaved(true);
    } else setRefusal(answer);
  }

  async function leave() {
    if (busy) return;
    setBusy(true);
    const answer = await writeContract(api, statusUnsubscribe, { token });
    setBusy(false);
    if (answer.ok) onChange(answer.data);
    else setRefusal(answer);
  }

  return { components, all, setAll, picked, setPicked, webhook, setWebhook, busy, saved, refusal, save, leave };
}
