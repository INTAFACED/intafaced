import { BRIDGE_ROUTES_UNSET, bridgeRoutesListOutputSchema } from '@intafaced/contracts/protocol-bridge';
import type { ApiClient } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../../shared/ui';
import { protocolCopy as copy } from '../copy';

type Translate = ReturnType<typeof copy.forLocale>['t'];

/**
 * The rails room's bridge (D-bridge-chain-03): the owner-published route table and the person's transfers. With the table
 * blank (`bridge.routes_unset`) the room keeps its full layout, names the owner decision and offers no route, so Start a
 * transfer stays disabled. The bridge is non-custodial: the wallet signs every step and nothing posts to the ledger.
 */
export function BridgeRoutes({ api, t }: { api: ApiClient; t: Translate }) {
  const routes = useResource(
    (signal) => api.query('protocol', 'bridge.routes.list', undefined, bridgeRoutesListOutputSchema, { signal }),
    'bridge.routes.list',
  );
  const { resource } = routes;
  const unset =
    resource.status === 'failed' &&
    (resource.failure.code === BRIDGE_ROUTES_UNSET || (resource.failure.message ?? '').startsWith(BRIDGE_ROUTES_UNSET));
  const list = resource.status === 'ready' ? resource.data.routes : [];
  const headers = [t('hdr_from'), t('hdr_to'), t('hdr_token'), t('hdr_provider')];
  return (
    <>
      <Panel title={t('bridgeRoutes')}>
        <DataTable label={t('bridgeRoutes')} headers={headers}>
          {resource.status === 'loading' ? (
            <tr>
              <td colSpan={headers.length}>
                <Loading />
              </td>
            </tr>
          ) : unset ? (
            <tr>
              <td colSpan={headers.length} data-code={BRIDGE_ROUTES_UNSET}>
                <p>{t('bridgeRoutesUnset')}</p>
                <span className="badge" data-blocker="owner.decision">
                  {t('ownerDecision')}
                </span>
              </td>
            </tr>
          ) : resource.status === 'failed' ? (
            <tr>
              <td colSpan={headers.length}>
                <Failure result={resource.failure} retry={routes.reload} />
              </td>
            </tr>
          ) : (
            list.map((route) => (
              <tr key={`${route.from.chainId}:${route.to.chainId}:${route.token}`}>
                <td>{route.from.name}</td>
                <td>{route.to.name}</td>
                <td>{route.token}</td>
                <td>{route.provider ?? t('providerUnset')}</td>
              </tr>
            ))
          )}
        </DataTable>
        <Button disabled title={t('startTransferBlocked')}>
          {t('startTransfer')}
        </Button>
        {list.length === 0 && <p className="muted">{t('startTransferBlocked')}</p>}
      </Panel>
      <Panel title={t('bridgeTransfers')}>
        <DataTable
          label={t('bridgeTransfers')}
          headers={[t('hdr_from'), t('hdr_to'), t('hdr_amount_sent'), t('hdr_state'), t('hdr_started')]}
        >
          <tr>
            <td colSpan={5}>
              <EmptyState title={t('bridgeTransfersEmpty')} />
            </td>
          </tr>
        </DataTable>
      </Panel>
    </>
  );
}
