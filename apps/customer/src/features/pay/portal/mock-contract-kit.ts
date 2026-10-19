import type { ApiResult } from '../../../shared/api';
import type { PortalApi } from './api';

/**
 * One call the contract test makes against the stand-in. `method` names the client function; `run` calls it with
 * sample input. The stand-in answers, and the client parses the answer with the schema it uses in production, so a
 * fixture that drifts from the real shape fails here and not in a screenshot.
 */
export type ContractCase = {
  method: keyof PortalApi;
  run: (portal: PortalApi) => Promise<ApiResult<unknown>>;
  /** Options for the stand-in, when the call needs it set up (for example `myAccess: 'finance'`). */
  mock?: { myAccess?: string; role?: string; emailInvites?: 'on' | 'off' | 'limited' };
};
/** A package's part: the calls it covers, and the client methods it knowingly has no fixture for yet (with the reason). */
export type ContractPart = { cases: ContractCase[]; notMocked: Partial<Record<keyof PortalApi, string>> };
