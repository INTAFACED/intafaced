import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { Banner, useProtocolTab } from '../volt/frame';
import { DataTable, EmptyState, Panel } from '../volt/parts';

/**
 * /chain/validators on the record-list template: the validator table, empty while the chain is parked, and the stake
 * actions, each disabled with the blocker it waits on. No validator is invented.
 */
export function ValidatorsRoom() {
  const tab = useProtocolTab('chain', 'validators');
  const { t } = tab.room;
  return (
    <div lang={tab.lang}>
      <RecordListTemplate
        title={tab.title}
        description={tab.description}
        state={{ kind: 'ready' }}
        filters={tab.sections}
        summary={<Banner />}
        list={
          <>
            <Panel title={t('validatorsTitle')}>
              <DataTable label={t('validatorsTitle')} headers={[t('hdr_validator'), t('hdr_stake'), t('hdr_status')]}>
                <tr>
                  <td colSpan={3}>
                    <EmptyState title={t('validatorsEmpty')} />
                  </td>
                </tr>
              </DataTable>
            </Panel>
            {tab.actions}
          </>
        }
      />
    </div>
  );
}
