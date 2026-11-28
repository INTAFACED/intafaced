import { date, funds, useBankRecordAs } from '../components';
import { incomingPageSchema, type IncomingLine } from '../contracts';
import { Failure, Loading, Panel } from '../bank-settings/parts';
import { incomingCopy } from '../incoming-copy';
import { BANK_ACTIVITY_LIST } from '@intafaced/contracts/bank-activity-procedures';

/**
 * Incoming payments (J-bank-02 #7): what came into the account, read from the ledger through `bank.activity.list`
 * (money in only), with when it arrived and when it could be used, and the rules for timing, availability, returns and
 * refusals in plain words. A ledger line is already in the available balance, so each one says so; nothing here is a
 * pending estimate. Every amount is the service's own string.
 */

const INCOMING_KINDS = ['deposit', 'welcome_funds', 'transfer_in'] as const;

function What({ line }: { line: IncomingLine }) {
  const { t } = incomingCopy.useCopy();
  if (line.kind === 'welcome_funds') return <>{t('kind_welcome_funds')}</>;
  if (line.kind === 'transfer_in') {
    return <>{line.counterparty ? t('kind_transfer_in', { handle: line.counterparty.handle }) : t('kind_transfer_in_unknown')}</>;
  }
  return <>{t('kind_deposit')}</>;
}

/** `more` is true when the bank has older lines than this page: then an empty page is not "nothing ever came in". */
export function IncomingRows({ lines, more = false }: { lines: readonly IncomingLine[]; more?: boolean }) {
  const { t } = incomingCopy.useCopy();
  const older = more && (
    <p className="lt-muted">
      <a className="lt-link" href="/uc/record">
        {t('older')}
      </a>
    </p>
  );
  if (lines.length === 0) {
    return (
      <>
        <p className="lt-muted">{t(more ? 'noneRecent' : 'none')}</p>
        {older}
      </>
    );
  }
  return (
    <div className="lt-rows">
      {lines.map((line) => (
        <div className="lt-row lt-row-between" key={line.id} data-testid="incoming-line">
          <div className="lt-stack-tight">
            <strong>
              <What line={line} />
            </strong>
            <small className="lt-muted">
              {t('arrived', { time: date(line.postedAt) })} {t('available')}
            </small>
          </div>
          <span className="lt-num" dir="ltr">
            {funds(line.amount, line.asset)}
          </span>
        </div>
      ))}
      {older}
    </div>
  );
}

export function IncomingRules() {
  const { t } = incomingCopy.useCopy();
  return (
    <div className="lt-stack-tight" data-testid="incoming-rules">
      <h3>{t('rulesTitle')}</h3>
      <ul className="lt-list">
        <li>{t('ruleTiming')}</li>
        <li>{t('ruleAvailable')}</li>
        <li>{t('ruleReturns')}</li>
        <li>{t('ruleRefused')}</li>
      </ul>
    </div>
  );
}

export function IncomingPayments() {
  const { t } = incomingCopy.useCopy();
  const read = useBankRecordAs(BANK_ACTIVITY_LIST, { limit: 20, direction: 'in', kind: [...INCOMING_KINDS] }, incomingPageSchema);
  const { resource } = read;
  return (
    <Panel title={t('title')} lead={t('lead')}>
      <div className="lt-stack">
        <div data-testid="incoming-payments">
          {resource.status === 'loading' ? (
            <Loading />
          ) : resource.status === 'failed' ? (
            <Failure result={resource.failure} retry={read.reload} />
          ) : (
            <IncomingRows lines={resource.data.items} more={resource.data.nextCursor !== null} />
          )}
        </div>
        <IncomingRules />
      </div>
    </Panel>
  );
}
