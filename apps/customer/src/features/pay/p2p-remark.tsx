import { useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui';
import { PayFailure, PayState } from './components';
import type { PersonalPayApi } from './pay-api';
import { remarkCopy } from './p2p-remark-copy';
import type { RemarkCase, Trade } from './schemas';

/** svc-p2p's REMARK_MAX: a quoted remark is at most this many characters once trimmed. */
const REMARK_MAX = 280;

/**
 * P-ads-merchant-19 / J-p2p-04: the payer reads the method's payment-note rules on a funded order before paying. A
 * method with rules per country shows the first row that has them; a method without rules, or a catalogue that cannot
 * be read, shows nothing, since the order page already names the method.
 */
export function PaymentNoteRules({ trade, pay, userId }: { trade: Trade; pay: PersonalPayApi; userId: string | null }) {
  if (userId === null || userId !== trade.buyerId || trade.status !== 'escrowed') return null;
  return <NoteRulesFor method={trade.method} pay={pay} />;
}

function NoteRulesFor({ method, pay }: { method: string; pay: PersonalPayApi }) {
  const { t } = remarkCopy.useCopy();
  // The same catalogue read as the offer forms, so an order page opened after them reads it from the cache.
  const methods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  if (methods.resource.status !== 'ready') return null;
  const rules = methods.resource.data.find((row) => row.methodId === method && row.noteRules)?.noteRules;
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
 * P-ads-merchant-19 / J-p2p-04 #5: either party to a funded order quotes a sensitive remark they found in a payment
 * note. svc-p2p opens a case for staff and tells the other party; one report per person per order, read back on every
 * visit, and the reported party sees that a case is open. Render it with `key={trade.id}` so another order starts a
 * fresh form.
 */
export function ReportRemark({ trade, pay, userId }: { trade: Trade; pay: PersonalPayApi; userId: string | null }) {
  // An order that was never funded has no payment note: the buyer pays only once the coin is held.
  if (trade.escrowedAt === null || trade.status === 'created') return null;
  return <RemarkSection trade={trade} pay={pay} userId={userId} />;
}

function RemarkSection({ trade, pay, userId }: { trade: Trade; pay: PersonalPayApi; userId: string | null }) {
  const own = useResource((signal) => pay.remarkCase(trade.id, signal), `pay:order-remark:${userId}:${trade.id}`);
  const [answered, setAnswered] = useState<RemarkCase | null>(null);
  if (answered) return <RemarkCaseOpened report={answered} />;
  return (
    <PayState resource={own.resource} retry={own.reload}>
      {({ mine, againstMe }) => (
        <>
          {againstMe ? <ReportedAgainstMe caseId={againstMe.caseId} /> : null}
          {mine ? <RemarkCaseOpened report={mine} /> : <RemarkForm trade={trade} pay={pay} onOpened={setAnswered} />}
        </>
      )}
    </PayState>
  );
}

/** The reported party's side: the other party reported a remark on this order. The quote stays with staff. */
function ReportedAgainstMe({ caseId }: { caseId: string }) {
  const { t } = remarkCopy.useCopy();
  return (
    <p role="status" data-testid="order-remark-against-me" data-case-id={caseId}>
      {t('againstMe')}
    </p>
  );
}

function RemarkCaseOpened({ report }: { report: RemarkCase }) {
  const { t } = remarkCopy.useCopy();
  return (
    <p role="status" data-testid="order-remark-case" data-case-id={report.id}>
      {t('reported')}
    </p>
  );
}

function RemarkForm({ trade, pay, onOpened }: { trade: Trade; pay: PersonalPayApi; onOpened: (report: RemarkCase) => void }) {
  const { t } = remarkCopy.useCopy();
  const [remark, setRemark] = useState('');
  // One case id per quote, so a resend after a lost answer is the same report; a different quote gets a new id.
  const sent = useRef({ quote: '', caseId: crypto.randomUUID() });
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const quoted = remark.trim();
  const tooLong = quoted.length > REMARK_MAX;
  const refusal =
    failure?.code === 'p2p.remark_case_exists'
      ? t('exists')
      : failure?.code === 'p2p.remark_invalid'
        ? t('invalid', { max: String(REMARK_MAX) })
        : null;
  const send = async () => {
    if (sent.current.quote !== quoted) sent.current = { quote: quoted, caseId: crypto.randomUUID() };
    setSending(true);
    setFailure(null);
    const result = await pay.reportSensitiveRemark(trade.id, sent.current.caseId, quoted);
    setSending(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    onOpened(result.data);
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
          <textarea value={remark} onChange={(event) => setRemark(event.target.value)} />
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
