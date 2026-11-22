import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { useBankNav } from '../bank-nav';
import type { ActionSpec } from '../components';
import { salaryCopy } from '../salary-copy';
import { SalaryRoom } from './Salary';

/**
 * `/bank/salary`: salary paid in by direct deposit, inside the Overview room (J-bank-30), on the flow template. The
 * bank's room row and the way back to the overview stay as the old bank page drew them.
 */
export function SalaryPage({ open }: { open: (spec: ActionSpec) => void }) {
  const nav = useBankNav('Overview');
  return (
    <FlowTemplate
      title={salaryCopy.t('title')}
      description={salaryCopy.t('description')}
      roomAction={
        <a className="lt-link" href="/bank">
          {nav.overview}
        </a>
      }
      state={{ kind: 'ready' }}
      step={
        <>
          <Tabs data-testid="money-bank-nav" label={nav.label} items={nav.items} current={nav.current} />
          <SalaryRoom open={open} />
        </>
      }
    />
  );
}
