import { defineCopy } from '../../shared/i18n';
import { date, funds, useBankRead } from './components';
import type { PartnerHolds as Holds } from './contracts';
import { DepthPanel, Fact } from './DepthParts';
import './bank-depth.css';

/** Words for what the partner holds back on Withdraw (J-wallet-01 #3). Every figure here is the partner's own. */
export const partnerHoldsCopy = defineCopy('partner-holds', {
  title: 'Held by {partner}',
  lead: '{partner} holds your money. What it still holds back of a purchase can be withdrawn once it releases it.',
  balance: 'Balance at {partner}',
  heldBack: 'Held back by {partner}',
  withdrawable: 'You can withdraw now',
  notReported: 'not reported by the partner',
  notKnown: 'not known',
  asOf: 'as of {time}',
  hold: "{partner}'s hold: {amount} from a {method} purchase, released {time}",
  released: 'Released by {partner}: {amount} from a {method} purchase, at {time}',
  card: 'card',
  bank_pull: 'bank pull',
  noHolds: '{partner} holds nothing back.',
  unread: 'What a partner holds back of your purchases could not be read.',
});

/**
 * What the partner still holds back of the person's purchases through it, and so what they can withdraw now from their
 * balance there (J-wallet-01 #3). Shown only to a person whose money the partner holds; everyone else sees nothing here.
 */
export function PartnerHolds() {
  const { t } = partnerHoldsCopy.useCopy();
  const read = useBankRead('partnerHolds', undefined);
  if (read.resource.status === 'loading') return null;
  // A read that failed says so in one line, and leaves the rest of Withdraw as it is.
  if (read.resource.status === 'failed') {
    return (
      <p role="status" className="money-caption" data-testid="partner-holds-unread" data-code={read.resource.failure.code ?? ''}>
        {t('unread')}
      </p>
    );
  }
  const data = read.resource.data;
  if (!data.held) return null;
  return <HeldView data={data} />;
}

export function HeldView({ data }: { data: Extract<Holds, { held: true }> }) {
  const { t } = partnerHoldsCopy.useCopy();
  const partner = data.label;
  return (
    <div data-testid="partner-holds" data-source={partner} data-reported={String(data.reported)} data-as-of={data.asOf ?? ''}>
      <DepthPanel title={t('title', { partner })} lead={t('lead', { partner })}>
        {data.balances.map((b) => (
          <dl
            className="bd-facts"
            key={b.assetId}
            data-testid="partner-withdrawable"
            data-asset={b.assetId}
            data-balance={b.balance ?? ''}
            data-held-back={b.heldBack ?? ''}
            data-withdrawable={b.withdrawable ?? ''}
          >
            <Fact label={t('balance', { partner })}>
              <span data-cell="balance">{b.balance === null ? t('notKnown') : funds(b.balance, b.assetId)}</span>{' '}
              {b.balanceAsOf && <small className="muted">{t('asOf', { time: date(b.balanceAsOf, true) })}</small>}
            </Fact>
            <Fact label={t('heldBack', { partner })}>
              <span data-cell="held-back">{b.heldBack === null ? t('notReported') : funds(b.heldBack, b.assetId)}</span>
            </Fact>
            <Fact label={t('withdrawable')}>
              <span data-cell="withdrawable">
                {b.withdrawable !== null ? funds(b.withdrawable, b.assetId) : data.reported ? t('notKnown') : t('notReported')}
              </span>
            </Fact>
          </dl>
        ))}
        {data.reported && data.holds.length === 0 && data.released.length === 0 && (
          <p className="money-caption">{t('noHolds', { partner })}</p>
        )}
        {data.holds.length > 0 && (
          <ul data-testid="partner-hold-list">
            {data.holds.map((h) => (
              <li key={h.id} data-testid="partner-hold" data-asset={h.assetId} data-amount={h.amount} data-release-at={h.releaseAt}>
                {t('hold', { partner, amount: funds(h.amount, h.assetId), method: t(h.paidBy), time: date(h.releaseAt) })}
              </li>
            ))}
          </ul>
        )}
        {data.released.length > 0 && (
          <ul data-testid="partner-release-list">
            {data.released.map((r) => (
              <li key={r.id} data-testid="partner-release" data-asset={r.assetId} data-amount={r.amount} data-released-at={r.releasedAt}>
                {t('released', { partner, amount: funds(r.amount, r.assetId), method: t(r.paidBy), time: date(r.releasedAt) })}
              </li>
            ))}
          </ul>
        )}
      </DepthPanel>
    </div>
  );
}
