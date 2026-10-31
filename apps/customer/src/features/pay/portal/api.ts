import type { ApiClient } from '../../../shared/api';
import { coreApi } from './api-core';
import { PAGE_SIZE, portalTools } from './api-tools';
import { moneyApi } from './money/api';
import { settlementAssetsApi } from './money/settlement-assets-api';
import { paymentsApi } from './payments/api';
import { settingsApi } from './settings/api';
import { catalogApi } from './catalog/api';
import { lookApi } from './payments/look-api';
import { methodsApi } from './payments/methods-api';

/**
 * The merchant portal's own client. Every procedure here scopes itself on the server from the signed
 * session: the merchant is never taken from this client, so there is no id to forge (M1/M2). The one
 * thing checked here is that someone is signed in. Money stays a decimal string end to end.
 *
 * The client is the sum of five parts: the shared core, then one part per package (`money/api.ts`,
 * `payments/api.ts`, `settings/api.ts`, `catalog/api.ts`). A method name used twice would let one part silently replace another,
 * so `api-registry.test.ts` fails on a duplicate.
 */
export type PortalApi = ReturnType<typeof createPortalApi>;

export { PAGE_SIZE };

export function createPortalApi(api: ApiClient, userId: string | null) {
  const tools = portalTools(api, userId);
  return {
    ...coreApi(tools),
    ...moneyApi(tools),
    ...settlementAssetsApi(tools),
    ...paymentsApi(tools),
    ...settingsApi(tools),
    ...catalogApi(tools),
    ...lookApi(tools),
    ...methodsApi(tools),
  };
}
