// volt-room: /bank/statements
import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { useBankNav } from '../bank-nav';
import { statementCentreCopy } from '../statement-centre-copy';
import { StatementCentre } from './StatementCentre';
import { StatementLetters, TaxStatements } from './StatementPanels';

/**
 * `/bank/statements`: the statement and export centre, inside the Analytics room (J-portfolio-11, PF-statements-01), on
 * the flow template. The bank's room row and the way back to the overview stay as the old bank page drew them.
 */
export function StatementsRoom() {
  const { t } = statementCentreCopy.useCopy();
  const nav = useBankNav('Analytics');
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
        <>
          <Tabs data-testid="money-bank-nav" label={nav.label} items={nav.items} current={nav.current} />
          <StatementCentre />
          <StatementLetters />
          <TaxStatements />
        </>
      }
    />
  );
}
