import { SUPPORT_HELP_CENTRE_OFF, supportHelpCentreSchema, type SupportHelpCentre } from '@intafaced/contracts/support-help-centre';
import type { ApiResult } from '../../shared/api';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { useResource, type Resource } from '../../shared/resource';
import { useApi } from '../session/session';

const helpCentreRead = contractProcedure('support', 'helpCentre', { output: supportHelpCentreSchema });

/**
 * The owner's help-centre settings (SP-help-centre-03), read signed out. Only an explicit `published: false` switches the
 * published answers off; a blank switch is the owner's silence, not "off", so the answers stay as they were. svc-support
 * enforces the switch itself: an answer door it refuses with `support.help_centre_off` is the same switched-off page, so a
 * settings read that failed or raced a change never shows answers the service would not serve.
 */
export function helpCentreSwitchedOff(read: Resource<SupportHelpCentre>, answers?: ApiResult<unknown> | null): boolean {
  if (answers && !answers.ok && answers.message === SUPPORT_HELP_CENTRE_OFF) return true;
  return read.status === 'ready' && read.data.published === false;
}

export function useHelpCentre(): Resource<SupportHelpCentre> {
  const api = useApi();
  return useResource((signal) => readContract(api, helpCentreRead, undefined, { signal }), 'help-centre').resource;
}
