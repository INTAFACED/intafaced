/**
 * Copy module public surface (D-S-03 / SPEC-SOVEREIGN-ROUTING-AND-COPY Stage).
 * Class M — fee-share moves value via ledger-client only when §8 rates publish.
 */

export {
  CopyService,
  LIST_MY_FOLLOWS_LIMIT_MAX,
  ListMyFollowsLimitUnsetError,
  publishedListMyFollowsLimit,
  TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET,
  type CopyServiceOptions,
  type FollowerFillFee,
  type LookupFollowerFillFeePort,
  type LeaderFill,
  type LookupLeaderFillPort,
} from './copy-service.js';
export {
  MemoryCopyFollowStore,
  SqlCopyFollowStore,
  type CopyFollowStore,
  type CopyPeriodStats,
  type ReserveEarningsResult,
  type AddExposureResult,
  type StoredMirrorPlan,
  type ClaimMirrorFillResult,
  type StoredSettledFeeShare,
  type RunFeeShareSettleOnceResult,
  type StoredPlacedMirror,
  type RunPlaceMirrorOnceResult,
} from './follow-store.js';
export { CopyError, COPY_FEE_SHARE_RESIDUAL, COPY_JURISDICTION_RESIDUAL, COPY_LAW_RESIDUAL, type CopyErrorCode } from './errors.js';
export {
  generateCopySessionKey,
  hashCopySessionKey,
  requireUnrevokedCopySessionKey,
  COPY_SESSION_KEY_MISSING_RESIDUAL,
  COPY_SESSION_KEY_REVOKED_RESIDUAL,
} from './session-key.js';
export {
  autoMirrorPlaceStatus,
  COPY_AUTO_MIRROR_PLACE_RESIDUAL,
  COPY_AUTO_MIRROR_PLACE_SOCKET,
  COPY_PLACE_DISABLED_RESIDUAL,
  COPY_PAPER_LIVE_RESIDUAL,
  copyMirrorClientOrderId,
  copyLimitPriceFromPlan,
  parseCopyPlaceMirrorFlag,
} from './auto-mirror-place.js';
export type { PlaceFollowerOrderPort, PlaceFollowerOrderInput, InspectCopyMarket } from './auto-mirror-place.js';
export {
  parseCopyFeeShareLawJson,
  parseCopyJurisdictionLawJson,
  requirePublishedCopyFeeShareLaw,
  requirePublishedCopyJurisdictionLaw,
  copyLawStatusLine,
  copyLawResidual,
  UNPUBLISHED_COPY_FEE_SHARE_LAW,
  UNPUBLISHED_COPY_JURISDICTION_LAW,
  type CopyFeeShareLaw,
  type CopyJurisdictionLaw,
} from './fee-share-law.js';
export {
  attributeCopyFeeShare,
  canonicalizeCopyFillId,
  planCopyFeeShareSettle,
  postCopyFeeShareSettle,
  refusePnlLinkedCopyFee,
  presentFeeShareAttribution,
} from './fee-share.js';
export {
  parseCopyEnvelope,
  assertCopyRegionAllowed,
  copyRegionClosed,
  presentCopyFollow,
  type CopyEnvelope,
  type CopyFollow,
  type PresentCopyFollow,
} from './follows.js';
export {
  COPY_CONTROL_DISPOSITIONS,
  COPY_RELATIONSHIP_STATES,
  applyCopyDetach,
  applyCopyPause,
  applyCopyResume,
  applyCopyStop,
  copyNewIntentFenced,
  followRelationshipState,
  presentCopyControlAck,
  requireCopyFollowId,
  requireNewCopyIntentAllowed,
  type CopyControlAck,
  type CopyControlDisposition,
  type CopyRelationshipState,
} from './copy-lifecycle.js';
export {
  COPY_FLATTEN_DISPOSITION,
  COPY_FLATTEN_PARTIAL_RESIDUAL,
  COPY_FLATTEN_REFUSED_RESIDUAL,
  applyCopyFlatten,
  flattenFollowerCopyPosition,
  presentCopyFlattenAck,
  type CopyFlattenAck,
  type CopyFlattenDisposition,
  type FlattenCopyPositionInput,
  type FlattenCopyPositionPort,
} from './copy-flatten.js';
export { copyFlattenClientOrderId, createFollowerFlattenPort, type FollowerFlattenPortDeps } from './follower-flatten-port.js';
export {
  bindCopyFollowerLimits,
  bindEnvelopeLimits,
  type CopyLeaderLimitSettings,
  type BoundCopyFollowerLimits,
} from './follower-limits.js';
export {
  planMirror,
  parseLeaderFillObservation,
  presentMirrorPlan,
  refuseCopyLeaderRanking,
  type MirrorPlan,
  type LeaderFillObservation,
  type MirrorSide,
} from './mirror.js';
