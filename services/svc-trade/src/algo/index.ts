/**
 * Algo module public surface (D-S-04 TWAP Stage).
 * Reachability: imported by TradeService + router.
 */
export {
  TwapEngine,
  projectTwapEndsAt,
  type TwapEnginePorts,
  type PlaceChildRequest,
  type PlaceChildResult,
  type SliceTickResult,
} from './twap-engine.js';
export { planTwapSlices, MAX_ALGO_SEED, type TwapSlicePlan } from './schedule.js';
export {
  planVwapSlices,
  planVwapSlicesFromFills,
  planPovSliceQty,
  timeframeForSliceInterval,
  alignLookbackVolumes,
} from './volume-plan.js';
export { SqlTwapParentStore, MemoryTwapParentStore, type TwapParentStore, type TwapParentRecord } from './parent-store.js';
export {
  hydrateAlgoIfMissing,
  hydrateAlgoFromStore,
  persistAlgoMutation,
  persistAlgoCancelAttempt,
  type AlgoHydrateTarget,
  type AlgoCancelTarget,
} from './hydrate-on-mutate.js';
export { captureAlgoPlaceGrant, principalFromAlgoGrant, parseAlgoPlaceGrant, type AlgoPlaceGrant } from './durable-principal.js';
export { startAlgoJobs, type AlgoJobsConfig, type AlgoJobsDeps, type AlgoJobsHandle } from './algo-jobs.js';
export {
  acceptableForAlgo,
  algoMarkMissing,
  withinPriceBand,
  DEFAULT_ALGO_MARK_POLICY,
  ALGO_MARK_MISSING,
  ALGO_MARK_UNUSABLE,
  ALGO_MARK_INVALID,
} from './mark-gate.js';
export {
  presentAlgoProgress,
  sumChildFillQtys,
  assertParentHasNoMoneyFields,
  assertProgressHasNoInventedFills,
  FORBIDDEN_PARENT_MONEY_KEYS,
} from './present.js';
export type {
  TwapParent,
  AlgoProgressView,
  CreateTwapInput,
  AlgoQuotedMark,
  AlgoMiss,
  AlgoChildRef,
  AlgoStatus,
  AlgoKind,
  AlgoScheduleStretchReason,
} from './types.js';
