/**
 * The answer schemas of the copy follow doors (`trade.copy.*`): each names every key its handler answers with
 * (`answerKeys`) and checks no more than the handler's own type, so a reply leaves exactly as it did before the schema
 * was added. Every answer here is built key by key (follows.ts, leader-listing.ts, leader-profile.ts,
 * copied-positions.ts, venue-copy.ts, copy-service.ts), so nothing outside these keys is ever stripped.
 */
import { answerKeys } from '../answer-keys.js';
import type { CheckVenueFollowAnswer, CopyService } from './copy-service.js';
import type { PresentCopyFollow } from './follows.js';
import type { LeaderDirectoryPage } from './leader-listing.js';
import type { LeaderProfile, LeaderTradesPage } from './leader-profile.js';
import {
  copyLeaderTradesAnswer,
  copyFollowAnswer,
  copyCheckVenueFollowAnswer,
  copyGrantSessionKeyAnswer,
  copyCloseCopiedPositionAnswer,
  copySkipLogAnswer,
  copyListMyFollowsAnswer,
  copyListLeadersAnswer,
  copyLeaderProfileAnswer,
  copyFollowPositionsAnswer,
  copyCopiedPositionsAnswer,
} from '@intafaced/contracts/trade-call-schemas';

type Answer<K extends keyof CopyService> = CopyService[K] extends (...args: never[]) => Promise<infer A> ? A : never;

answerKeys<LeaderDirectoryPage>()(copyListLeadersAnswer);

answerKeys<LeaderProfile>()(copyLeaderProfileAnswer);

answerKeys<LeaderTradesPage>()(copyLeaderTradesAnswer);

answerKeys<PresentCopyFollow>()(copyFollowAnswer);
answerKeys<Answer<'startFollow'> | Answer<'startVenueFollow'> | Answer<'amendFollow'> | Answer<'killSessionKey'>>()(copyFollowAnswer);

answerKeys<Answer<'grantSessionKey'>>()(copyGrantSessionKeyAnswer);

answerKeys<CheckVenueFollowAnswer>()(copyCheckVenueFollowAnswer);

answerKeys<Answer<'followPositions'>>()(copyFollowPositionsAnswer);

answerKeys<Answer<'copiedPositions'>>()(copyCopiedPositionsAnswer);

answerKeys<Answer<'closePosition'>>()(copyCloseCopiedPositionAnswer);

answerKeys<Answer<'skipLog'>>()(copySkipLogAnswer);

answerKeys<Answer<'listMyFollows'>>()(copyListMyFollowsAnswer);
export {
  copyLeaderTradesAnswer,
  copyFollowAnswer,
  copyCheckVenueFollowAnswer,
  copyGrantSessionKeyAnswer,
  copyCloseCopiedPositionAnswer,
  copySkipLogAnswer,
};
export { copyListMyFollowsAnswer, copyListLeadersAnswer, copyLeaderProfileAnswer, copyFollowPositionsAnswer, copyCopiedPositionsAnswer };
