import { CardStack, CardStackLoading, Logo } from '@intafaced/ui/lit';
import { homeCopy } from './copy';
import { fmtUsd, type HomePortfolio, type Loadable } from './deps';
import { Money } from './volt-parts';

/**
 * Volt's money object on Home: the kit's card stack, cash in front, crypto behind it. Each card opens its part of Money.
 * Figures are the portfolio's own (decimal strings, never numbers); nothing on a card is made up.
 */
export function VoltStack({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  if (portfolio.status === 'loading') return <CardStackLoading />;
  if (portfolio.status !== 'ready' || portfolio.data.holdings.length === 0) return null;
  const data = portfolio.data;
  return (
    <CardStack
      label={t('Your holdings')}
      data-testid="volt-stack"
      back={{ label: t('Crypto'), href: '/money#crypto', value: <Money value={fmtUsd(data.cryptoUsd)} hidden={hidden} /> }}
      front={{
        label: t('Cash'),
        href: '/money#cash',
        mark: <Logo variant="mark" size={24} />,
        value: <Money value={fmtUsd(data.cashUsd)} hidden={hidden} />,
      }}
    />
  );
}
