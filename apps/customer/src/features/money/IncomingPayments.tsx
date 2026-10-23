import { Failure, Loading } from '../../shared/ui';
import { date, funds, useBankRead } from './components';
import type { IncomingLine } from './contracts';
import { DepthPanel } from './DepthParts';
import { incomingCopy } from './incoming-copy';
import './bank-depth.css';

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
    <p className="money-caption">
      <a className="text-link" href="/uc/record">
        {t('older')}
      </a>
    </p>
  );
  if (lines.length === 0) {
    return (
      <>
        <p className="money-caption">{t(more ? 'noneRecent' : 'none')}</p>
        {older}
      </>
    );
  }
  return (
    <>
      {lines.map((line) => (
        <div className="money-space-row" key={line.id} data-testid="incoming-line">
          <div>
            <strong>
              <What line={line} />
            </strong>
            <small>
              {t('arrived', { time: date(line.postedAt) })} {t('available')}
            </small>
          </div>
          <span className="numeric" dir="ltr">
            {funds(line.amount, line.asset)}
          </span>
        </div>
      ))}
      {older}
    </>
  );
}

export function IncomingRules() {
  const { t } = incomingCopy.useCopy();
  return (
    <div data-testid="incoming-rules">
      <h4 className="bd-subhead">{t('rulesTitle')}</h4>
      <ul className="bd-list">
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
  const read = useBankRead('activity.list', { limit: 20, direction: 'in', kind: [...INCOMING_KINDS] });
  const { resource } = read;
  return (
    <DepthPanel title={t('title')} lead={t('lead')}>
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
    </DepthPanel>
  );
}
