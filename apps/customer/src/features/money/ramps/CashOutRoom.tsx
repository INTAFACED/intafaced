import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { useBankNav } from '../bank-nav';
import { cashOutCopy } from '../cash-out-copy';
import { CashOut } from './CashOut';

/**
 * `/bank/ramps/cash-out`: cash out to one of the person's linked bank accounts (J-bank-03), on the flow template.
 * The bank's room row comes first; the Ramps room has no overview link.
 */
export function CashOutRoom() {
  const { t } = cashOutCopy.useCopy();
  const nav = useBankNav('Ramps');
  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={{ kind: 'ready' }}
      step={
        <>
          <Tabs data-testid="money-bank-nav" label={nav.label} items={nav.items} current={nav.current} />
          <CashOut />
        </>
      }
    />
  );
}
