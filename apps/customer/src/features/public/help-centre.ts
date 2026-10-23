import { supportHelpCentreSchema, type SupportHelpCentre } from '@intafaced/contracts/support-help-centre';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { useResource, type Resource } from '../../shared/resource';
import { useApi } from '../session/session';

const helpCentreRead = contractProcedure('support', 'helpCentre', { output: supportHelpCentreSchema });

/**
 * The owner's help-centre settings (SP-help-centre-03), read signed out. Only an explicit `published: false` switches the
 * published answers off; a blank switch is the owner's silence, not "off", so the answers stay as they were.
 */
export function helpCentreSwitchedOff(read: Resource<SupportHelpCentre>): boolean {
  return read.status === 'ready' && read.data.published === false;
}

export function useHelpCentre(): Resource<SupportHelpCentre> {
  const api = useApi();
  return useResource((signal) => readContract(api, helpCentreRead, undefined, { signal }), 'help-centre').resource;
}
