import { useEffect, useReducer, useState } from 'react';
import { formatAmount, parseAmount, type PersonalPayApi } from './deps';

/** The published limits and fee for one send, as `bank.transfers.quote` answers them. */
export type SendQuote = {
  assetId: string;
  amount: string;
  perTransferLimit: string;
  dailyLimit: string;
  spentToday: string;
  fee: string;
  feeBlocker: string | null;
  withinPerTransfer: boolean;
  withinDaily: boolean;
};

export type SendTerms =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ready'; quote: SendQuote }
  /** Nothing is published for this asset: the service refuses every send until compliance publishes limits. */
  | { kind: 'unset' }
  | { kind: 'unavailable' };

/** What the terms mean for the form: the line under the amount, and why Review is off (null when it is on). */
export type TermsVerdict =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'ok'; fee: string; perTransfer: string; left: string; leftAfter: string }
  | { kind: 'unset' }
  | { kind: 'feeUnwired' }
  | { kind: 'overPayment'; limit: string }
  | { kind: 'overDaily'; left: string }
  | { kind: 'unavailable' };

const DEBOUNCE_MS = 300;

/**
 * Reads the limits and fee for the asset and amount being sent. A blank amount reads nothing. An answer for an amount
 * or asset that is no longer on screen is never shown: it reads as "checking" until the current one arrives.
 */
export function useSendTerms(pay: PersonalPayApi, assetId: string | null, amount: string | null): [SendTerms, () => void] {
  const key = assetId && amount ? `${assetId}:${amount}` : '';
  const [answer, setAnswer] = useState<{ key: string; terms: SendTerms }>({ key: '', terms: { kind: 'idle' } });
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!assetId || !amount) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void pay.quote({ assetId, amount }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        const terms: SendTerms = result.ok
          ? { kind: 'ready', quote: result.data }
          : result.code === 'bank.personal_transfer_terms_unset'
            ? { kind: 'unset' }
            : { kind: 'unavailable' };
        setAnswer({ key: `${assetId}:${amount}`, terms });
      });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pay, assetId, amount, attempt]);
  if (!key) return [{ kind: 'idle' }, retry];
  return [answer.key === key ? answer.terms : { kind: 'checking' }, retry];
}

/** Reads a quote the way the service applies it: per payment first, then what is left of today, then the fee. */
export function termsVerdict(terms: SendTerms, amount: string | null): TermsVerdict {
  if (terms.kind === 'idle') return { kind: 'none' };
  if (terms.kind !== 'ready') return { kind: terms.kind };
  const { quote } = terms;
  if (amount === null || parseAmount(quote.amount) !== parseAmount(amount)) return { kind: 'checking' };
  const daily = parseAmount(quote.dailyLimit);
  const spent = parseAmount(quote.spentToday);
  const left = daily > spent ? daily - spent : 0n;
  if (!quote.withinPerTransfer) return { kind: 'overPayment', limit: quote.perTransferLimit };
  if (!quote.withinDaily) return { kind: 'overDaily', left: formatAmount(left) };
  if (quote.feeBlocker !== null) return { kind: 'feeUnwired' };
  const after = left - parseAmount(quote.amount);
  return {
    kind: 'ok',
    fee: quote.fee,
    perTransfer: quote.perTransferLimit,
    left: formatAmount(left),
    leftAfter: formatAmount(after > 0n ? after : 0n),
  };
}
