import { useEffect, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui';
import { PayFailure } from './components';
import type { PersonalPayApi } from './pay-api';
import { remarkCopy } from './p2p-remark-copy';
import type { z } from 'zod';
import type { methodSchema, RemarkCase, Trade } from './schemas';

/** svc-p2p's REMARK_MAX: a quoted remark is at most this many characters once trimmed. */
const REMARK_MAX = 280;

/**
 * P-ads-merchant-19 / J-p2p-04: the payer reads the method's payment-note rules on the order before paying. The catalogue
 * row is read for the order's method; a method with rules per country shows the first row that has them, and a method
 * without rules (or a catalogue that cannot be read) shows nothing, since the order page already names the method.
 */
export function PaymentNoteRules({ trade, pay, userId }: { trade: Trade; pay: PersonalPayApi; userId: string | null }) {
  const { t } = remarkCopy.useCopy();
  const show = userId !== null && userId === trade.buyerId && trade.status === 'escrowed';
  const methods = useResource(
    (signal) => (show ? pay.methods(signal) : Promise.resolve({ ok: true as const, data: [] as z.infer<typeof methodSchema>[] })),
    `pay:order-note-rules:${userId}:${trade.id}:${show}`,
  );
  if (!show || methods.resource.status !== 'ready') return null;
  const rules = methods.resource.data.find((row) => row.methodId === trade.method && row.noteRules)?.noteRules;
  if (!rules) return null;
  return (
    <div className="stack" data-testid="order-note-rules">
      <strong>{t('noteTitle')}</strong>
      <p lang="und">{rules.guidance}</p>
      {rules.forbidden.length > 0 ? (
        <p data-testid="order-note-forbidden">
          {t('noteForbidden')}: <span lang="und">{rules.forbidden.join(', ')}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * P-ads-merchant-19 / J-p2p-04 #5: either party quotes a sensitive remark they found in a payment note. svc-p2p opens a
 * case for staff and tells the other party; one report per person per order, and a repeat press of the same report
 * answers the same case.
 */
export function ReportRemark({ trade, pay }: { trade: Trade; pay: PersonalPayApi }) {
  const { t } = remarkCopy.useCopy();
  // One case id per form, so a retry after a lost answer is the same report, not a second one.
  const [caseId, setCaseId] = useState(() => crypto.randomUUID());
  const [remark, setRemark] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [answered, setAnswered] = useState<RemarkCase | null>(null);
  useEffect(() => {
    setAnswered(null);
    setFailure(null);
    setRemark('');
    setCaseId(crypto.randomUUID());
  }, [trade.id]);
  if (trade.status === 'created') return null;
  if (answered) {
    return (
      <p role="status" data-testid="order-remark-case" data-case-id={answered.id}>
        {t('reported')}
      </p>
    );
  }
  const quoted = remark.trim();
  const tooLong = quoted.length > REMARK_MAX;
  const refusal =
    failure?.code === 'p2p.remark_case_exists'
      ? t('exists')
      : failure?.code === 'p2p.remark_invalid'
        ? t('invalid', { max: String(REMARK_MAX) })
        : null;
  const send = async () => {
    setSending(true);
    setFailure(null);
    const result = await pay.reportSensitiveRemark(trade.id, caseId, quoted);
    setSending(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setAnswered(result.data);
  };
  return (
    <details className="p2p-order-other" data-testid="order-remark-report">
      <summary>{t('title')}</summary>
      <p className="muted">{t('why')}</p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="field">
          <span>{t('remark')}</span>
          <textarea
            value={remark}
            onChange={(event) => {
              setRemark(event.target.value);
              // A different quote is a different report: a new id, so it is never read as a replay of the last one.
              setCaseId(crypto.randomUUID());
            }}
          />
        </label>
        {quoted === '' ? (
          <p className="muted">{t('remarkMissing')}</p>
        ) : tooLong ? (
          <p className="muted">{t('tooLong', { max: String(REMARK_MAX) })}</p>
        ) : null}
        <Button type="submit" variant="secondary" disabled={sending || quoted === '' || tooLong}>
          {t('report')}
        </Button>
      </form>
      {refusal ? (
        <p className="failure" role="status">
          {refusal}
        </p>
      ) : failure ? (
        <PayFailure result={failure} retry={send} />
      ) : null}
    </details>
  );
}
