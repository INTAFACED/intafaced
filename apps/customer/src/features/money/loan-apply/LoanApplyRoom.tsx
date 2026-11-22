// volt-room: /bank/loans/apply
import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import type { ActionSpec } from '../components';
import { useBankNav } from '../bank-nav';
import { loanApplyCopy } from '../loan-apply-copy';
import { LoanApply } from './LoanApply';

/**
 * `/bank/loans/apply?product=<id>`: choose a loan, work out its collateral, check what applies and open it (J-bank-09),
 * in the Loans room of the bank, on the flow template.
 */
export function LoanApplyRoom({ search, open }: { search: string; open: (spec: ActionSpec) => void }) {
  const { t } = loanApplyCopy.useCopy();
  const nav = useBankNav('Loans');
  const productId = new URLSearchParams(search).get('product');
  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      roomAction={
        <a className="lt-link" href="/bank">
          {nav.overview}
        </a>
      }
      state={{ kind: 'ready' }}
      step={
        <div>
          <Tabs data-testid="money-bank-nav" label={nav.label} items={nav.items} current={nav.current} />
          <LoanApply productId={productId && productId.trim() !== '' ? productId : null} open={open} />
        </div>
      }
    />
  );
}
