import { useState } from 'react';
import { z } from 'zod';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import { defineCopy } from '../../../../shared/i18n';
import type { ApiResult } from '../../../../shared/api';
import { useSessionIfAny } from '../../../session/session';
import { payStepUp } from '../access/step-up-store';
import { formatMoney } from '../ui/format';
import { paymentLabel } from '../presentation';

/**
 * J-merchant-06 #6 and #7: the payment actions that are not a plain refund.
 *
 * - Void (an authorised, uncaptured payment): nothing was taken, so nothing is posted; the service records the release.
 * - Reverse: the service decides void or refund, never the page; a refund goes with the "Confirm it's you" token.
 * - Bulk refund: the payments chosen on the list, each refunded once under its batch row, with a report per row.
 *
 * Every figure here is the service's own answer; the page computes no amount.
 */
const en = {
  voidAction: 'Void payment',
  voidTitle: 'Void this payment?',
  voidBody: 'The authorisation is released. Nothing has been taken from the customer, so nothing is refunded.',
  voidDone: 'Nothing was taken from the customer, and your balance did not change.',
  reverseAction: 'Reverse payment',
  reverseTitle: 'Reverse this payment?',
  reverseRefund: 'This payment was captured, so reversing it refunds {amount}.',
  reverseDone: 'Reversed with a refund of {amount}.',
  reverseVoided: 'Reversed by releasing the authorisation. Nothing was taken.',
  cancel: 'Keep it',
  close: 'Close',
  refused: 'This didn’t go through: {reason}',
  stepUp: "Confirm it's you with a passkey or authenticator code to refund.",
  bulkTitle: 'Refund several payments',
  bulkBody: 'Choose payments to refund in full of what is left on each. Each runs once; the report names any refused.',
  select: 'Select payment {label} {id}',
  bulkAction: 'Refund selected',
  bulkConfirmTitle: 'Refund {n} payments?',
  bulkConfirmBody: 'Each payment is refunded in full of what is left on it, once.',
  bulkRun: 'Refund all',
  bulkReport: 'Bulk refund report',
  bulkSummary: '{ok} refunded, {refused} refused',
  bulkUnknown: '{n} not confirmed yet: run again to check them; nothing is refunded twice.',
  bulkAgain: 'Run again',
  rowRefunded: 'Refunded',
  rowRefused: 'Refused',
  rowUnknown: 'Not confirmed',
  colPayment: 'Payment',
  colAmount: 'Amount',
  colOutcome: 'Outcome',
  reason_nothing: 'Nothing is left to refund on this payment.',
  reason_dispute: 'This payment has an open dispute.',
  reason_approval: 'Above your approval rule: it waits for a teammate’s approval.',
  reason_other: 'The refund was refused ({code}).',
} as const;
const copy = defineCopy('pay.portal.payment-actions', en);

const paymentOut = z.object({ id: z.string(), status: z.string(), refundedAmount: z.string(), assetId: z.string() });
const reverseOut = z.object({ used: z.enum(['void', 'refund']), amount: z.string(), payment: paymentOut });
const bulkOut = z.object({
  batchId: z.string(),
  rows: z.array(
    z.object({
      row: z.number(),
      paymentId: z.string(),
      amount: z.string().nullable(),
      refundId: z.string(),
      outcome: z.enum(['pending', 'refunded', 'refused', 'unknown']),
      refusalCode: z.string().nullable(),
    }),
  ),
});

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Receipts kept for this page's life: the room re-reads the payment (or the list) after an action, which remounts the
 * action, and the receipt must still be there. Memory only, never storage: a new page reads the payment itself.
 */
const reversed = new Map<string, z.infer<typeof reverseOut>>();
const bulkReports = new Map<string, { batchId: string; ids: string[]; out: z.infer<typeof bulkOut> }>();
const why = (f: Failure) => f.message || f.code || 'error';

/** Void: only for an authorised, uncaptured payment. */
export function VoidAction({ paymentId, onDone }: { paymentId: string; onDone: () => void }) {
  const { t } = copy.useCopy();
  const session = useSessionIfAny();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  async function run() {
    if (!session) return;
    setBusy(true);
    const result = await session.api.mutate('pay', 'payment.void', { paymentId }, paymentOut);
    setBusy(false);
    setOpen(false);
    if (!result.ok) return setFailure(result);
    setFailure(null);
    onDone();
  }
  if (!session) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={busy}>
        {t('voidAction')}
      </Button>
      {failure && <p role="alert">{t('refused', { reason: why(failure) })}</p>}
      {open && (
        <Dialog title={t('voidTitle')} closeLabel={t('close')} onClose={() => setOpen(false)}>
          <p>{t('voidBody')}</p>
          <div className="pp-actions">
            <Button variant="primary" onClick={() => void run()} disabled={busy}>
              {t('voidAction')}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** What a voided payment says, under its status. */
export function VoidedNote() {
  const { t } = copy.useCopy();
  return (
    <p className="pp-callout" role="note">
      {t('voidDone')}
    </p>
  );
}

/** What a reverse on this page did, under the payment's status, once the room has read the payment again. */
export function ReversedNote({ paymentId, assetId }: { paymentId: string; assetId: string }) {
  const { t } = copy.useCopy();
  const done = reversed.get(paymentId);
  if (!done) return null;
  return (
    <p className="pp-callout" role="status">
      {done.used === 'refund' ? t('reverseDone', { amount: `${formatMoney(done.amount, assetId)} ${assetId}` }) : t('reverseVoided')}
    </p>
  );
}

/** Reverse a captured payment: the confirmation first, then the review, then the service decides how. */
export function ReverseAction({
  paymentId,
  refundable,
  assetId,
  onDone,
}: {
  paymentId: string;
  refundable: string;
  assetId: string;
  onDone: () => void;
}) {
  const { t } = copy.useCopy();
  const session = useSessionIfAny();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<z.infer<typeof reverseOut> | null>(reversed.get(paymentId) ?? null);
  const money = (v: string) => `${formatMoney(v, assetId)} ${assetId}`;
  async function start() {
    if (!(await payStepUp.ensure('refund'))) return setFailure(t('stepUp'));
    setFailure(null);
    setOpen(true);
  }
  async function run() {
    setBusy(true);
    if (!(await payStepUp.ensure('refund'))) {
      setBusy(false);
      setOpen(false);
      return setFailure(t('stepUp'));
    }
    const result = await session!.api.mutate('pay', 'payment.reverse', { paymentId }, reverseOut);
    setBusy(false);
    setOpen(false);
    if (!result.ok) return setFailure(t('refused', { reason: why(result) }));
    reversed.set(paymentId, result.data);
    setDone(result.data);
    onDone();
  }
  // A money action needs a signed-in session; a view rendered without one shows no action.
  if (done || !session) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => void start()} disabled={busy}>
        {t('reverseAction')}
      </Button>
      {failure && <p role="alert">{failure}</p>}
      {open && (
        <Dialog title={t('reverseTitle')} closeLabel={t('close')} onClose={() => setOpen(false)}>
          <p>{t('reverseRefund', { amount: money(refundable) })}</p>
          <div className="pp-actions">
            <Button variant="primary" onClick={() => void run()} disabled={busy}>
              {t('reverseAction')}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

type Pick = { id: string; status: string; assetId: string; amount: string; customerRef?: string | null; description?: string | null };

const REFUNDABLE = new Set(['captured', 'settled', 'refunded']);

/**
 * The batch's business key: the business and the payments chosen, in a fixed order, hashed to a uuid. The same
 * selection always names the same batch, so a retry after a lost reply, a reload or a second click replays each row
 * under its first key (`refund:<paymentId>:bulk:<batchId>:<row>`) and never sends it again under a new one.
 */
export async function bulkBatchId(merchantId: string, paymentIds: readonly string[]): Promise<string> {
  const ids = [...paymentIds].map((id) => id.toLowerCase()).sort();
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bulk-refund:${merchantId.toLowerCase()}:${ids.join(',')}`)),
  );
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The payments on this page that a refund could apply to, chosen by hand, then refunded once each. */
export function BulkRefund({ merchantId, payments, onDone }: { merchantId: string; payments: readonly Pick[]; onDone: () => void }) {
  const { t } = copy.useCopy();
  const session = useSessionIfAny();
  const candidates = payments.filter((p) => REFUNDABLE.has(p.status));
  const [chosen, setChosen] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [report, setReport] = useState<{ batchId: string; ids: string[]; out: z.infer<typeof bulkOut> } | null>(
    bulkReports.get(merchantId) ?? null,
  );
  // A batch sent whose answer has not come back: "Run again" sends the same batch, never a new one.
  const [unanswered, setUnanswered] = useState<{ batchId: string; ids: string[] } | null>(null);
  if ((candidates.length === 0 && !report) || !session) return null;
  async function run(batch: { batchId: string; ids: string[] }) {
    setBusy(true);
    if (!(await payStepUp.ensure('refund'))) {
      setBusy(false);
      setOpen(false);
      return setFailure(t('stepUp'));
    }
    setUnanswered(batch);
    const result = await session!.api.mutate(
      'pay',
      'payment.bulkRefund',
      { merchantId, batchId: batch.batchId, rows: batch.ids.map((paymentId) => ({ paymentId })) },
      bulkOut,
    );
    setBusy(false);
    setOpen(false);
    if (!result.ok) return setFailure(t('refused', { reason: why(result) }));
    setUnanswered(null);
    setFailure(null);
    const next = { ...batch, out: result.data };
    bulkReports.set(merchantId, next);
    setReport(next);
    onDone();
  }
  const reason = (code: string | null) =>
    code === 'pay.nothing_captured' || code === 'pay.refund_exceeds_captured'
      ? t('reason_nothing')
      : code === 'pay.refund_open_dispute'
        ? t('reason_dispute')
        : code === 'pay.refund_request_invalid' || code === 'pay.guard_refund_approval_required'
          ? t('reason_approval')
          : t('reason_other', { code: code ?? '—' });
  const label = (id: string) => {
    const p = payments.find((x) => x.id === id);
    return p ? paymentLabel(p as never) : id.slice(0, 8);
  };
  return (
    <section className="pp-section" aria-label={t('bulkTitle')}>
      <h2>{t('bulkTitle')}</h2>
      <p className="muted">{t('bulkBody')}</p>
      <ul className="pp-checklist">
        {candidates.map((p) => (
          <li key={p.id}>
            <label>
              <input
                type="checkbox"
                aria-label={t('select', { label: paymentLabel(p as never), id: p.id.slice(0, 8) })}
                checked={chosen.includes(p.id)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
              />{' '}
              {paymentLabel(p as never)} · {formatMoney(p.amount, p.assetId)} {p.assetId}
            </label>
          </li>
        ))}
      </ul>
      <Button
        variant="secondary"
        disabled={chosen.length === 0 || busy}
        onClick={async () => {
          if (!(await payStepUp.ensure('refund'))) return setFailure(t('stepUp'));
          setFailure(null);
          setOpen(true);
        }}
      >
        {t('bulkAction')}
      </Button>
      {failure && <p role="alert">{failure}</p>}
      {unanswered && !busy && !report && (
        <Button variant="secondary" onClick={() => void run(unanswered)}>
          {t('bulkAgain')}
        </Button>
      )}
      {open && (
        <Dialog title={t('bulkConfirmTitle', { n: chosen.length })} closeLabel={t('close')} onClose={() => setOpen(false)}>
          <p>{t('bulkConfirmBody')}</p>
          <div className="pp-actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                const ids = [...chosen];
                await run({ batchId: await bulkBatchId(merchantId, ids), ids });
              }}
            >
              {t('bulkRun')}
            </Button>
          </div>
        </Dialog>
      )}
      {report && (
        <section role="region" aria-label={t('bulkReport')}>
          <h3>{t('bulkReport')}</h3>
          <p role="status">
            {t('bulkSummary', {
              ok: report.out.rows.filter((r) => r.outcome === 'refunded').length,
              refused: report.out.rows.filter((r) => r.outcome === 'refused').length,
            })}
          </p>
          {report.out.rows.some((r) => r.outcome === 'unknown' || r.outcome === 'pending') && (
            <p role="note">
              {t('bulkUnknown', { n: report.out.rows.filter((r) => r.outcome === 'unknown' || r.outcome === 'pending').length })}
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th scope="col">{t('colPayment')}</th>
                <th scope="col">{t('colAmount')}</th>
                <th scope="col">{t('colOutcome')}</th>
              </tr>
            </thead>
            <tbody>
              {report.out.rows.map((r) => (
                <tr key={r.row}>
                  <td>{label(r.paymentId)}</td>
                  <td>{r.amount ? formatMoney(r.amount, payments.find((p) => p.id === r.paymentId)?.assetId ?? '') : '—'}</td>
                  <td>
                    {r.outcome === 'refunded'
                      ? t('rowRefunded')
                      : r.outcome === 'refused'
                        ? `${t('rowRefused')}: ${reason(r.refusalCode)}`
                        : t('rowUnknown')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button variant="secondary" disabled={busy} onClick={() => void run({ batchId: report.batchId, ids: report.ids })}>
            {t('bulkAgain')}
          </Button>
        </section>
      )}
    </section>
  );
}
