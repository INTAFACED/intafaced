/**
 * The answer schemas of `trade.rfq.board`, `trade.algo.list`, `trade.algo.policy` and `trade.options.policy`: each names
 * every key its handler answers with (`answerKeys`) and checks no more than the handler's own type, so a reply leaves
 * exactly as it did before the schema was added.
 */
import { answerKeys } from '../answer-keys.js';
import type { AlgoPolicySummary } from '../algo/algo-policy.js';
import type { RfqBoard } from '../otc/rfq-board.js';
import type { OptionsPolicySummary } from '../spot/options-policy.js';
import type { TradeService } from '../spot/trade-service.js';
import { algoPolicyAnswer, algoListAnswer, rfqBoardAnswer, optionsPolicyAnswer } from '@intafaced/contracts/trade-call-schemas';

answerKeys<RfqBoard>()(rfqBoardAnswer);

answerKeys<Awaited<ReturnType<TradeService['algoList']>>>()(algoListAnswer);

answerKeys<AlgoPolicySummary>()(algoPolicyAnswer);

answerKeys<OptionsPolicySummary>()(optionsPolicyAnswer);
