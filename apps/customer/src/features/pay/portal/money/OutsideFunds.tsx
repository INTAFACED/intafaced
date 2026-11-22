import type { OutsideFunds as Funds } from '@intafaced/contracts/merchant-receiving-wallet';
import type { Resource } from '../../../../shared/resource';
import { walletCopy as c } from '../payments/wallet-copy';
import { DateTime } from '../ui/DateTime';
import { EntityList, Loading, MoneyText, Section } from '../volt/parts';
import { MoneyFailure } from './kit-parts';

type Row = Funds['rows'][number];

/**
 * `/pay/money`: the money customers paid that is outside INTAFACED's book (launch money model, J-merchant-04): in the
 * business's own wallet, as the chain reports it, or with the payment partner, as the partner reports it. Clearing and
 * available are their figures with the time of the newest report, never a ledger balance. A business with none sees one
 * sentence, never a row of zeros.
 */
export function OutsideFunds({ funds, retry, test }: { funds: Resource<Funds>; retry: () => void; test: boolean }) {
  const where = (r: Row) => c.t(r.holder === 'own_wallet' ? 'whereOwnWallet' : 'wherePartner');
  const source = (r: Row) => c.t(r.source === 'chain' ? 'sourceChain' : 'sourcePartner');
  return (
    <Section title={c.t('outsideTitle')} description={c.t('outsidePurpose')}>
      <div data-testid="outside-funds">
        {funds.status === 'loading' && <Loading rows={2} />}
        {funds.status === 'failed' && <MoneyFailure result={funds.failure} retry={retry} />}
        {funds.status === 'ready' && funds.data.rows.length === 0 && <p className="lt-hint">{c.t('outsideEmpty')}</p>}
        {funds.status === 'ready' && funds.data.rows.length > 0 && (
          <EntityList
            label={c.t('outsideTitle')}
            rows={funds.data.rows}
            rowKey={(r) => `${r.holder}:${r.assetId}`}
            columns={[
              { header: c.t('outsideAsset'), cell: (r) => r.assetId },
              { header: c.t('outsideWhere'), cell: where },
              { header: c.t('outsideClearing'), cell: (r) => <MoneyText value={r.clearing} asset={r.assetId} test={test} /> },
              { header: c.t('outsideAvailable'), cell: (r) => <MoneyText value={r.available} asset={r.assetId} test={test} /> },
              { header: c.t('outsideSource'), cell: source },
              { header: c.t('outsideAsOf'), cell: (r) => <DateTime value={r.asOf} /> },
              { header: c.t('outsidePayments'), cell: (r) => String(r.payments) },
            ]}
          />
        )}
      </div>
    </Section>
  );
}
