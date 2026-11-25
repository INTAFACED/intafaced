import { DateTime } from '../ui/DateTime';
import { MoneyText } from '../volt/parts';
import type { mc } from './copy';
import { lineSign } from './model';
import type { PayStatementLine as StatementLine } from '@intafaced/contracts/pay-portal-reads';

type Words = ReturnType<typeof mc.useCopy>['t'];
const KNOWN_KINDS = ['payment_captured', 'fee', 'refund', 'chargeback', 'settlement', 'payout', 'reserve'] as const;
const KNOWN_ACCOUNTS = ['clearing', 'proceeds', 'userAvailable', 'houseFees', 'payoutHold'] as const;
export const kindWords = (t: Words, kind: string) =>
  (KNOWN_KINDS as readonly string[]).includes(kind) ? t(`stmKind_${kind}` as 'stmKind_fee') : t('stmKind_other');
export const accountWords = (t: Words, account: string) =>
  (KNOWN_ACCOUNTS as readonly string[]).includes(account) ? t(`stmAccount_${account}` as 'stmAccount_clearing') : t('stmAccount_other');

/** The signed amount of one line, in words a merchant reads: "+ 12.50 USDT" in, "− 3.00 USDT" out (`SignedAmount` in `./Statement`). */
function SignedAmount({
  line,
  test,
}: {
  line: Pick<StatementLine, 'amount' | 'assetId' | 'direction' | 'account' | 'kind'>;
  test: boolean;
}) {
  const sign = lineSign(line);
  return (
    <span>
      <span aria-hidden="true">{sign === 1 ? '+ ' : sign === -1 ? '− ' : ''}</span>
      <MoneyText value={line.amount} asset={line.assetId} test={test} />
    </span>
  );
}

/** The recent lines of the statement on Money, drawn from the kit: when, what (with its payment or settlement), which balance, how much. */
export function movementColumns(t: Words, test: boolean) {
  return [
    { header: t('mnColWhen'), cell: (l: StatementLine) => <DateTime value={l.at} /> },
    {
      header: t('mnColWhat'),
      cell: (l: StatementLine) => (
        <>
          {kindWords(t, l.kind)}
          {l.paymentId && (
            <small className="lt-hint">
              {' '}
              <a className="lt-link" href={`/pay/payments/${encodeURIComponent(l.paymentId)}`}>
                {t('stmOpenPayment')}
              </a>
            </small>
          )}
          {l.settlementId && (
            <small className="lt-hint">
              {' '}
              <a className="lt-link" href={`/pay/settlements/${encodeURIComponent(l.settlementId)}`}>
                {t('stmOpenSettlement')}
              </a>
            </small>
          )}
        </>
      ),
    },
    { header: t('mnColAccount'), cell: (l: StatementLine) => accountWords(t, l.account) },
    { header: t('colAmount'), cell: (l: StatementLine) => <SignedAmount line={l} test={test} /> },
  ];
}
