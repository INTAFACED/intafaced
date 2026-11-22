// volt-room: /chain/validators/:validatorId
import { Button } from '@intafaced/ui/lit';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { protocolCopy as copy } from '../copy';
import { Banner } from '../volt/frame';
import { DataTable, EmptyState, Panel } from '../volt/parts';

/**
 * One validator (`/chain/validators/:validatorId`) on the monitor template. INTACHAIN is parked, so no validator record exists
 * yet: the page keeps its full layout, its table's columns with no invented rows, and names the chain blocker
 * (`data-blocker`). A malformed id is answered `protocol.not_found` without looking anything up.
 */
export function ValidatorPage({ validatorId, valid }: { validatorId?: string; valid: boolean }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = copy.forLocale(language);
  const title = t('page_validatorDetail');
  const headers = [t('hdr_validator'), t('hdr_stake'), t('hdr_status')];
  return (
    <div lang={renderedLocale} data-route="validatorDetail">
      <MonitorTemplate
        title={validatorId && valid ? `${title} ${validatorId}` : title}
        description={t('pendingNote')}
        state={{ kind: 'ready' }}
        figures={[]}
        panels={
          <>
            <Banner />
            {valid ? (
              <Panel title={t('pendingBlockedBy')}>
                <DataTable label={title} headers={headers}>
                  <tr>
                    <td colSpan={headers.length}>
                      <div data-blocker="chain" role="status">
                        <EmptyState title={t('blocker_chain')} />
                      </div>
                    </td>
                  </tr>
                </DataTable>
              </Panel>
            ) : (
              <Panel title={t('pendingNotFoundTitle')}>
                <div data-code="protocol.not_found" role="status">
                  <EmptyState title={t('pendingNotFoundBody', { what: t('what_validator') })} />
                </div>
              </Panel>
            )}
            <Button tone="secondary" onClick={() => navigate('/chain')}>
              {t('pendingBack', { room: t('roomChain') })}
            </Button>
          </>
        }
      />
    </div>
  );
}
