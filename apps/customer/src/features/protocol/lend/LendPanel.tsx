import { LENDING_MARKET_UNSET } from '@intafaced/contracts/protocol-lending-position';
import { useResource } from '../../../shared/resource';
import { Button, Failure, Loading, Panel } from '../../../shared/ui';
import type { createProtocolApi } from '../api';
import type { protocolCopy } from '../copy';
import { bpsPercent } from '../liquidity/format';
import { useWallet } from '../wallet/WalletProvider';

type Translate = ReturnType<typeof protocolCopy.forLocale>['t'];
type Api = ReturnType<typeof createProtocolApi>;

/**
 * The Lend room (D-portfolio-wallet-04, J-dex-protocol-06 #4): the connected wallet's position in the isolated lending
 * market, its collateral and debt, read from the market contract at one block. With no market set the room says so by
 * code (`protocol.lending_market_unset`) and shows no zero in its place. Nothing here signs or sends.
 */
export function LendPanel({ api, t }: { api: Api; t: Translate }) {
  const wallet = useWallet();
  const account = wallet.status === 'connected' && wallet.address ? wallet.address : null;
  return (
    <Panel title={t('lendTitle')} aria-label={t('lendTitle')}>
      <p className="muted">{t('lendLead')}</p>
      {account ? <Position api={api} t={t} account={account} /> : <p className="muted">{t('lendConnect')}</p>}
      <div className="protocol-actions">
        <Button variant="secondary" disabled aria-disabled="true" title={t('lendSupplyBlocked')}>
          {t('lendSupply')}
        </Button>
        <p className="protocol-actions__reason" role="note">
          {t('lendSupplyBlocked')}
        </p>
      </div>
    </Panel>
  );
}

function Position({ api, t, account }: { api: Api; t: Translate; account: string }) {
  const read = useResource((signal) => api.lendingPosition(account, signal), `protocol-room:lend:${account.toLowerCase()}`);
  if (read.resource.status === 'loading') return <Loading label={t('lendTitle')} />;
  if (read.resource.status === 'failed') {
    const failure = read.resource.failure;
    if (failure.code === LENDING_MARKET_UNSET || failure.message.startsWith(LENDING_MARKET_UNSET))
      return (
        <p role="note" data-code={LENDING_MARKET_UNSET}>
          {failure.message}
        </p>
      );
    return <Failure result={failure} retry={read.reload} />;
  }
  const p = read.resource.data;
  const symbol = (token: { symbol: string | null; address: string }) => token.symbol ?? token.address;
  return (
    <dl className="protocol-facts" data-lending-market={p.market}>
      <div>
        <dt>{t('lendMarket')}</dt>
        <dd>
          <code>{p.market}</code>
        </dd>
      </div>
      <div>
        <dt>{t('lendCollateralToken')}</dt>
        <dd>{symbol(p.collateralToken)}</dd>
      </div>
      <div>
        <dt>{t('lendBorrowToken')}</dt>
        <dd>{symbol(p.borrowToken)}</dd>
      </div>
      <div>
        <dt>{t('lendMaxLtv')}</dt>
        <dd className="numeric">{bpsPercent(p.maxLtvBps)}%</dd>
      </div>
      <div>
        <dt>{t('lendYourCollateral')}</dt>
        <dd className="numeric">
          {p.collateral} {symbol(p.collateralToken)}
        </dd>
      </div>
      <div>
        <dt>{t('lendYourDebt')}</dt>
        <dd className="numeric">
          {p.debt} {symbol(p.borrowToken)}
        </dd>
      </div>
      <div>
        <dt>{t('lendAtBlock')}</dt>
        <dd className="numeric">{p.blockNumber}</dd>
      </div>
    </dl>
  );
}
