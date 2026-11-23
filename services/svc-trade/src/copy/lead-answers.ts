/**
 * The copy lead doors' answer schemas (`trade.copy.*` for a lead's own desk, and the public pauses). Each names every
 * key its handler answers with (`answerKeys`) and checks no more than the handler's own type, so a reply leaves
 * exactly as it did before the schema was added.
 */
import { z } from 'zod';
import { answerKeys } from '../answer-keys.js';
import type { LeadEligibility, MyLeadAccount, MyLeadApplication, LeadMissionsView } from './lead-applications.js';
import type { LeadEarnings, LeadLevel } from './lead-desk.js';
import type { LeadCopierView, LeadTradesView } from './lead-trading.js';
import type { PublicPauses } from './platform-pauses.js';
import {
  myLeadApplicationAnswer,
  leadEligibilityAnswer,
  applyToLeadAnswer,
  myLeadAnswer,
  leadEarningsAnswer,
  leadLevelAnswer,
  leadMissionsAnswer,
  leadTradesAnswer,
  leadCopiersAnswer,
  platformPausesAnswer,
} from '@intafaced/contracts/trade-call-schemas';

answerKeys<MyLeadApplication>()(applyToLeadAnswer);

answerKeys<MyLeadApplication | null>()(myLeadApplicationAnswer);

answerKeys<LeadEligibility>()(leadEligibilityAnswer);

answerKeys<MyLeadAccount | null>()(myLeadAnswer);

answerKeys<LeadEarnings>()(leadEarningsAnswer);

answerKeys<LeadLevel>()(leadLevelAnswer);

answerKeys<LeadMissionsView>()(leadMissionsAnswer);

answerKeys<LeadTradesView>()(leadTradesAnswer);

answerKeys<LeadCopierView[]>()(leadCopiersAnswer);

/** `copy.setProfitShare` and `copy.setMaxRatio`: both always refuse, so neither ever answers. */
export const refusedAlwaysAnswer = z.void();
answerKeys<void>()(refusedAlwaysAnswer);

answerKeys<PublicPauses>()(platformPausesAnswer);
export {
  myLeadApplicationAnswer,
  leadEligibilityAnswer,
  applyToLeadAnswer,
  myLeadAnswer,
  leadEarningsAnswer,
  leadLevelAnswer,
  leadMissionsAnswer,
  leadTradesAnswer,
  leadCopiersAnswer,
  platformPausesAnswer,
};
