import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { WalletProvider } from '../../protocol';
import { addMoneyCopy } from '../add-money-copy';
import { useBankNav } from '../bank-nav';
import { AddMoney } from './AddMoney';

/**
 * `/bank/ramps/new`: Add money (J-bank-02), on the flow template. The bank's room row comes first; the Ramps room has
 * no overview link. The browser wallet's connection wraps it, so a purchase can be delivered straight to the person's
 * own wallet (J-dex-protocol-05 #4).
 */
export function AddMoneyRoom() {
  return (
    <WalletProvider>
      <AddMoneyFlow />
    </WalletProvider>
  );
}

function AddMoneyFlow() {
  const { t } = addMoneyCopy.useCopy();
  const nav = useBankNav('Ramps');
  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={{ kind: 'ready' }}
      step={
        <>
          <Tabs data-testid="money-bank-nav" label={nav.label} items={nav.items} current={nav.current} />
          <AddMoney />
        </>
      }
    />
  );
}
