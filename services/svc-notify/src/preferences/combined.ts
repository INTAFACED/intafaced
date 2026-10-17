/**
 * Notify L3 — combined mute + digest prefs (TRK-ops.notifications).
 *
 * Single pure view for dispatch: critical always immediate and never muted;
 * non-critical may mute channels and/or batch into digests.
 */

import { isChannelMuted, type ChannelMutePrefs, type MuteableChannel, type NotifySeverity, EMPTY_MUTE_PREFS } from './mute.js';
import { DEFAULT_DIGEST_PREFS, mayEnterDigest, shouldSendImmediate, type DigestPrefs } from './digest.js';

export type CombinedNotifyPrefs = {
  readonly mute: ChannelMutePrefs;
  readonly digest: DigestPrefs;
};

export const DEFAULT_COMBINED_PREFS: CombinedNotifyPrefs = {
  mute: EMPTY_MUTE_PREFS,
  digest: DEFAULT_DIGEST_PREFS,
};

export type DeliveryDecision =
  | { readonly action: 'send_now'; readonly channel: MuteableChannel | 'inapp' }
  | { readonly action: 'hold_digest'; readonly channel: MuteableChannel }
  | { readonly action: 'skip_muted'; readonly channel: MuteableChannel }
  | { readonly action: 'inapp_only' };

/**
 * Decide out-of-app delivery for one channel.
 * inapp is never muted and never digests (inbox lands immediately).
 */
export function decideChannelDelivery(
  prefs: CombinedNotifyPrefs,
  channel: MuteableChannel | 'inapp',
  severity: NotifySeverity,
): DeliveryDecision {
  if (channel === 'inapp') {
    return { action: 'send_now', channel: 'inapp' };
  }
  if (isChannelMuted(prefs.mute, channel, severity)) {
    return { action: 'skip_muted', channel };
  }
  if (!shouldSendImmediate(prefs.digest, severity) && mayEnterDigest(severity)) {
    return { action: 'hold_digest', channel };
  }
  return { action: 'send_now', channel };
}

/** Critical fanout never digests and never skips muteable channels as muted. */
export function criticalAlwaysImmediate(prefs: CombinedNotifyPrefs, channel: MuteableChannel): boolean {
  const d = decideChannelDelivery(prefs, channel, 'critical');
  return d.action === 'send_now';
}

/**
 * L3 — plan delivery for a multi-channel fanout in one pass.
 * Channels list is caller-owned; missing channels are not invented.
 */
export function planFanoutDelivery(
  prefs: CombinedNotifyPrefs,
  channels: readonly (MuteableChannel | 'inapp')[],
  severity: NotifySeverity,
): readonly DeliveryDecision[] {
  return channels.map((ch) => decideChannelDelivery(prefs, ch, severity));
}

/**
 * L3 — summarize a fanout plan by action (operator honesty board).
 * Empty plan → zeros; never invents channels not in the plan.
 */
export type FanoutPlanSummary = {
  readonly sendNow: number;
  readonly holdDigest: number;
  readonly skipMuted: number;
  readonly total: number;
};

export function summarizeFanoutPlan(plan: readonly DeliveryDecision[]): FanoutPlanSummary {
  let sendNow = 0;
  let holdDigest = 0;
  let skipMuted = 0;
  for (const d of plan) {
    if (d.action === 'send_now') sendNow += 1;
    else if (d.action === 'hold_digest') holdDigest += 1;
    else if (d.action === 'skip_muted') skipMuted += 1;
  }
  return { sendNow, holdDigest, skipMuted, total: plan.length };
}

/** L3 — channels that should send immediately (no invent missing channels). */
export function channelsToSendNow(plan: readonly DeliveryDecision[]): readonly (MuteableChannel | 'inapp')[] {
  return plan.filter((d): d is Extract<DeliveryDecision, { action: 'send_now' }> => d.action === 'send_now').map((d) => d.channel);
}

/** L3 — channels held for digest (no invent; never inapp). */
export function channelsHeldForDigest(plan: readonly DeliveryDecision[]): readonly MuteableChannel[] {
  return plan.filter((d): d is Extract<DeliveryDecision, { action: 'hold_digest' }> => d.action === 'hold_digest').map((d) => d.channel);
}

/** L3 — channels skipped as muted (no invent; never inapp). */
export function channelsSkippedMuted(plan: readonly DeliveryDecision[]): readonly MuteableChannel[] {
  return plan.filter((d): d is Extract<DeliveryDecision, { action: 'skip_muted' }> => d.action === 'skip_muted').map((d) => d.channel);
}

/** L3 — count of hold_digest decisions. Empty plan → 0. */
export function countHoldingChannels(plan: readonly DeliveryDecision[]): number {
  return channelsHeldForDigest(plan).length;
}

/** L3 — count of send_now decisions. Empty plan → 0. */
export function countSendNowChannels(plan: readonly DeliveryDecision[]): number {
  return channelsToSendNow(plan).length;
}

/** L3 — count of skip_muted decisions. Empty plan → 0. */
export function countSkippedMuted(plan: readonly DeliveryDecision[]): number {
  return channelsSkippedMuted(plan).length;
}

/**
 * L3 — true when plan has zero skip_muted decisions. Empty plan → true.
 */
export function planHasNoMutes(plan: readonly DeliveryDecision[]): boolean {
  return countSkippedMuted(plan) === 0;
}

/**
 * L3 — true when every decision is send_now. Empty plan → false (not invent all-send).
 */
export function planIsAllSendNow(plan: readonly DeliveryDecision[]): boolean {
  if (plan.length === 0) return false;
  return plan.every((d) => d.action === 'send_now');
}

/** L3 — true when fanout plan has no decisions. */
export function planIsEmpty(plan: readonly DeliveryDecision[]): boolean {
  return plan.length === 0;
}

/** L3 — true when any decision is hold_digest. Empty → false. */
export function planHasHolds(plan: readonly DeliveryDecision[]): boolean {
  return countHoldingChannels(plan) > 0;
}

/** L3 — true when any decision is skip_muted. Empty → false. */
export function planHasSkips(plan: readonly DeliveryDecision[]): boolean {
  return plan.some((d) => d.action === 'skip_muted');
}

/** L3 — send_now count. Empty → 0. */
export function countSendNow(plan: readonly DeliveryDecision[]): number {
  return plan.filter((d) => d.action === 'send_now').length;
}

/** L3 — alias of countSkippedMuted. */
export function planSkipCount(plan: readonly DeliveryDecision[]): number {
  return countSkippedMuted(plan);
}

/** L3 — alias of countHoldingChannels. */
export function planHoldCount(plan: readonly DeliveryDecision[]): number {
  return countHoldingChannels(plan);
}

/** L3 — alias of countSendNowChannels. */
export function planSendCount(plan: readonly DeliveryDecision[]): number {
  return countSendNowChannels(plan);
}

/** L3 — true when plan has any send_now. Empty → false. */
export function planHasSends(plan: readonly DeliveryDecision[]): boolean {
  return planSendCount(plan) > 0;
}

/** L3 — total decisions in plan. Empty → 0. */
export function planDecisionCount(plan: readonly DeliveryDecision[]): number {
  return plan.length;
}

/**
 * L3 — send_now / total as fixed 4dp string. Empty plan → null (never invent 0 send).
 */
export function planSendRatio(plan: readonly DeliveryDecision[]): string | null {
  if (plan.length === 0) return null;
  return (planSendCount(plan) / plan.length).toFixed(4);
}

/**
 * L3 — true when plan has mixed actions (not all same). Empty → false.
 */
export function planIsMixed(plan: readonly DeliveryDecision[]): boolean {
  if (plan.length === 0) return false;
  const first = plan[0]!.action;
  return plan.some((d) => d.action !== first);
}

/**
 * L3 — hold/total as fixed 4dp. Empty plan → null (never invent 0 hold).
 */
export function planHoldRatio(plan: readonly DeliveryDecision[]): string | null {
  if (plan.length === 0) return null;
  return (planHoldCount(plan) / plan.length).toFixed(4);
}

/**
 * L3 — skip/total as fixed 4dp. Empty → null.
 */
export function planSkipRatio(plan: readonly DeliveryDecision[]): string | null {
  if (plan.length === 0) return null;
  return (planSkipCount(plan) / plan.length).toFixed(4);
}

/** L3 — true when plan has zero holds. Empty → true. */
export function planHasNoHolds(plan: readonly DeliveryDecision[]): boolean {
  return planHoldCount(plan) === 0;
}

/** L3 — unique actions present (stable order send_now, hold_digest, skip_muted). Empty → []. */
export function planActionsPresent(plan: readonly DeliveryDecision[]): readonly DeliveryDecision['action'][] {
  const order: DeliveryDecision['action'][] = ['send_now', 'hold_digest', 'skip_muted'];
  const present = new Set(plan.map((d) => d.action));
  return order.filter((a) => present.has(a));
}

/** L3 — true when plan has only holds and/or skips (no send). Empty → false. */
export function planIsAllDeferred(plan: readonly DeliveryDecision[]): boolean {
  if (plan.length === 0) return false;
  return plan.every((d) => d.action === 'hold_digest' || d.action === 'skip_muted');
}

/** L3 — inapp channels in send_now list. Empty → []. */
export function planInappSendChannels(plan: readonly DeliveryDecision[]): readonly 'inapp'[] {
  return channelsToSendNow(plan).filter((c): c is 'inapp' => c === 'inapp');
}

/** L3 — true when inapp is scheduled send_now. Empty → false. */
export function planSendsInapp(plan: readonly DeliveryDecision[]): boolean {
  return planInappSendChannels(plan).length > 0;
}

/** L3 — non-inapp send_now channels. Empty → []. */
export function planOutOfAppSends(plan: readonly DeliveryDecision[]): readonly MuteableChannel[] {
  return channelsToSendNow(plan).filter((c): c is MuteableChannel => c !== 'inapp');
}

/** L3 — true when plan has zero decisions that are not send_now. Empty → false. */
export function planOnlySendsOrEmpty(plan: readonly DeliveryDecision[]): boolean {
  return plan.length === 0 || planIsAllSendNow(plan);
}

/** L3 — hold channels sorted for stable UI. Empty → []. */
export function planHoldChannelsSorted(plan: readonly DeliveryDecision[]): readonly MuteableChannel[] {
  return [...channelsHeldForDigest(plan)].sort();
}

/** L3 — skip channels sorted. Empty → []. */
export function planSkipChannelsSorted(plan: readonly DeliveryDecision[]): readonly MuteableChannel[] {
  return [...channelsSkippedMuted(plan)].sort();
}

/** L3 — decision count by action. Empty zeros. */
export function planActionHistogram(plan: readonly DeliveryDecision[]): {
  readonly send_now: number;
  readonly hold_digest: number;
  readonly skip_muted: number;
} {
  return {
    send_now: planSendCount(plan),
    hold_digest: planHoldCount(plan),
    skip_muted: planSkipCount(plan),
  };
}

/** L3 — true when histogram has only send_now > 0. Empty → false. */
export function planHistogramOnlySends(plan: readonly DeliveryDecision[]): boolean {
  const h = planActionHistogram(plan);
  return h.send_now > 0 && h.hold_digest === 0 && h.skip_muted === 0;
}

/** L3 — true when histogram has only skips. Empty → false. */
export function planHistogramOnlySkips(plan: readonly DeliveryDecision[]): boolean {
  const h = planActionHistogram(plan);
  return h.skip_muted > 0 && h.send_now === 0 && h.hold_digest === 0;
}

/** L3 — true when histogram has only holds. Empty → false. */
export function planHistogramOnlyHolds(plan: readonly DeliveryDecision[]): boolean {
  const h = planActionHistogram(plan);
  return h.hold_digest > 0 && h.send_now === 0 && h.skip_muted === 0;
}

/** L3 — action kinds with count > 0. Empty → []. */
export function planNonZeroActions(plan: readonly DeliveryDecision[]): readonly DeliveryDecision['action'][] {
  const h = planActionHistogram(plan);
  const out: DeliveryDecision['action'][] = [];
  if (h.send_now > 0) out.push('send_now');
  if (h.hold_digest > 0) out.push('hold_digest');
  if (h.skip_muted > 0) out.push('skip_muted');
  return out;
}

/** L3 — true when decision count is at least n. */
export function planHasAtLeastDecisions(plan: readonly DeliveryDecision[], n: number): boolean {
  if (!Number.isFinite(n) || n < 0) return false;
  return plan.length >= Math.floor(n);
}

/** L3 — send_now minus hold_digest count. */
export function planSendMinusHold(plan: readonly DeliveryDecision[]): number {
  return planSendCount(plan) - planHoldCount(plan);
}

/** L3 — first send channel in plan order. None → null. */
export function firstSendChannel(plan: readonly DeliveryDecision[]): (MuteableChannel | 'inapp') | null {
  const ch = channelsToSendNow(plan);
  return ch[0] ?? null;
}

/** L3 — last send channel in plan order. None → null. */
export function lastSendChannel(plan: readonly DeliveryDecision[]): (MuteableChannel | 'inapp') | null {
  const ch = channelsToSendNow(plan);
  return ch.length ? ch[ch.length - 1]! : null;
}

/** L3 — plan length label. */
export function planDecisionCountLabel(plan: readonly DeliveryDecision[]): string {
  return String(planDecisionCount(plan));
}

/** L3 — send count label. */
export function planSendCountLabel(plan: readonly DeliveryDecision[]): string {
  return String(planSendCount(plan));
}

/** L3 — hold count label. */
export function planHoldCountLabel(plan: readonly DeliveryDecision[]): string {
  return String(planHoldCount(plan));
}

/** L3 — skip count label. */
export function planSkipCountLabel(plan: readonly DeliveryDecision[]): string {
  return String(planSkipCount(plan));
}

/** L3 — send channels joined. Empty → "". */
export function planSendChannelsJoined(plan: readonly DeliveryDecision[]): string {
  return channelsToSendNow(plan).join(',');
}

/** L3 — hold channels joined (sorted). Empty → "". */
export function planHoldChannelsJoined(plan: readonly DeliveryDecision[]): string {
  return planHoldChannelsSorted(plan).join(',');
}

/** L3 — skip channels joined (sorted). Empty → "". */
export function planSkipChannelsJoined(plan: readonly DeliveryDecision[]): string {
  return planSkipChannelsSorted(plan).join(',');
}

/** L3 — actions present joined. Empty → "". */
export function planActionsPresentJoined(plan: readonly DeliveryDecision[]): string {
  return planActionsPresent(plan).join(',');
}

/** L3 — send ratio label or empty. */
export function planSendRatioLabel(plan: readonly DeliveryDecision[]): string {
  return planSendRatio(plan) ?? '';
}

/** L3 — hold ratio label or empty. */
export function planHoldRatioLabel(plan: readonly DeliveryDecision[]): string {
  return planHoldRatio(plan) ?? '';
}

/** L3 — skip ratio label or empty. */
export function planSkipRatioLabel(plan: readonly DeliveryDecision[]): string {
  return planSkipRatio(plan) ?? '';
}

/** L3 — first send channel label or empty. */
export function firstSendChannelLabel(plan: readonly DeliveryDecision[]): string {
  return firstSendChannel(plan) ?? '';
}

/** L3 — action histogram snapshot (alias of planActionHistogram). */
export function planActionSnapshot(plan: readonly DeliveryDecision[]): {
  readonly send_now: number;
  readonly hold_digest: number;
  readonly skip_muted: number;
  readonly total: number;
} {
  const h = planActionHistogram(plan);
  return { ...h, total: plan.length };
}

/** L3 — true when histogram parts sum to plan length. */
export function planActionCountsConsistent(plan: readonly DeliveryDecision[]): boolean {
  const s = planActionSnapshot(plan);
  return s.total === s.send_now + s.hold_digest + s.skip_muted;
}

/** L3 — ratio snapshot (nulls when empty). */
export function planRatioSnapshot(plan: readonly DeliveryDecision[]): {
  readonly send: string | null;
  readonly hold: string | null;
  readonly skip: string | null;
} {
  return {
    send: planSendRatio(plan),
    hold: planHoldRatio(plan),
    skip: planSkipRatio(plan),
  };
}

/** L3 — channel partition snapshot. */
export function planChannelPartition(plan: readonly DeliveryDecision[]): {
  readonly send: readonly (MuteableChannel | 'inapp')[];
  readonly hold: readonly MuteableChannel[];
  readonly skip: readonly MuteableChannel[];
} {
  return {
    send: channelsToSendNow(plan),
    hold: channelsHeldForDigest(plan),
    skip: channelsSkippedMuted(plan),
  };
}

/** L3 — fanout plan board card. */
export function planBoardCard(plan: readonly DeliveryDecision[]): {
  readonly total: number;
  readonly send: number;
  readonly hold: number;
  readonly skip: number;
  readonly empty: boolean;
  readonly allSend: boolean;
  readonly mixed: boolean;
  readonly sendRatio: string | null;
  readonly actions: readonly DeliveryDecision['action'][];
} {
  return {
    total: planDecisionCount(plan),
    send: planSendCount(plan),
    hold: planHoldCount(plan),
    skip: planSkipCount(plan),
    empty: planIsEmpty(plan),
    allSend: planIsAllSendNow(plan),
    mixed: planIsMixed(plan),
    sendRatio: planSendRatio(plan),
    actions: planActionsPresent(plan),
  };
}

/** L3 — true when plan board has sends. */
export function planBoardHasSends(plan: readonly DeliveryDecision[]): boolean {
  return planBoardCard(plan).send > 0;
}

/** L3 — true when plan board is empty. */
export function planBoardIsEmpty(plan: readonly DeliveryDecision[]): boolean {
  return planBoardCard(plan).empty;
}

/** L3 — channel lists for plan board. */
export function planBoardChannels(plan: readonly DeliveryDecision[]): {
  readonly send: readonly (MuteableChannel | 'inapp')[];
  readonly hold: readonly MuteableChannel[];
  readonly skip: readonly MuteableChannel[];
} {
  return planChannelPartition(plan);
}

/** L3 — filter plan decisions by action. Empty → []. */
export function filterPlanByAction(plan: readonly DeliveryDecision[], action: DeliveryDecision['action']): readonly DeliveryDecision[] {
  return plan.filter((d) => d.action === action);
}

/** L3 — true when plan has action. */
export function planIncludesAction(plan: readonly DeliveryDecision[], action: DeliveryDecision['action']): boolean {
  return plan.some((d) => d.action === action);
}

/** L3 — count decisions for action. Empty → 0. */
export function countPlanAction(plan: readonly DeliveryDecision[], action: DeliveryDecision['action']): number {
  return filterPlanByAction(plan, action).length;
}

/** L3 — filter send channels by substring. Empty needle → []. */
export function filterPlanSendChannels(plan: readonly DeliveryDecision[], needle: string): readonly (MuteableChannel | 'inapp')[] {
  const n = needle.trim();
  if (!n) return [];
  return channelsToSendNow(plan).filter((c) => c.includes(n));
}

export const NOTIFY_COMBINED_PAGE_LIMIT_UNSET = 'notify.combined_page_limit_unset' as const;

/** Combined plan page size unpublished. Blank is not `all.length`. */
export class NotifyCombinedPageLimitUnsetError extends Error {
  readonly code = NOTIFY_COMBINED_PAGE_LIMIT_UNSET;
  constructor() {
    super(NOTIFY_COMBINED_PAGE_LIMIT_UNSET);
    this.name = 'NotifyCombinedPageLimitUnsetError';
  }
}

/**
 * Owner-published combined plan page size.
 * Blank / non-finite / <1 refuses. Never invent `all.length` / `plan.length`.
 * A tRPC door maps this to PRECONDITION_FAILED (same as notify.list).
 */
export function assertCombinedPageLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new NotifyCombinedPageLimitUnsetError();
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new NotifyCombinedPageLimitUnsetError();
  }
  return n;
}

export const NOTIFY_COMBINED_PAGE_OFFSET_UNSET = 'notify.combined_page_offset_unset' as const;

/** Combined plan page offset is non-finite. Omitted stays 0. Never invent a page. */
export class NotifyCombinedPageOffsetUnsetError extends Error {
  readonly code = NOTIFY_COMBINED_PAGE_OFFSET_UNSET;
  constructor() {
    super(NOTIFY_COMBINED_PAGE_OFFSET_UNSET);
    this.name = 'NotifyCombinedPageOffsetUnsetError';
  }
}

/**
 * Combined plan page offset.
 * Omitted stays 0. Non-finite refuses. Finite values floor and clamp at 0.
 * Never invent a page size.
 */
export function assertCombinedPageOffset(offset: number | null | undefined): number {
  if (offset === undefined || offset === null) return 0;
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    throw new NotifyCombinedPageOffsetUnsetError();
  }
  return Math.max(0, Math.floor(offset));
}

/** L3 — page plan decisions. Empty → []. Omit limit refuses. Non-finite offset refuses. */
export function pagePlanDecisions(
  plan: readonly DeliveryDecision[],
  options: { offset?: number; limit?: number } = {},
): readonly DeliveryDecision[] {
  const offset = assertCombinedPageOffset(options.offset);
  const limit = assertCombinedPageLimit(options.limit);
  return plan.slice(offset, offset + limit);
}

/** L3 — page send channels. Empty → []. Omit limit refuses. Non-finite offset refuses. */
export function pagePlanSendChannels(
  plan: readonly DeliveryDecision[],
  options: { offset?: number; limit?: number } = {},
): readonly (MuteableChannel | 'inapp')[] {
  const all = channelsToSendNow(plan);
  const offset = assertCombinedPageOffset(options.offset);
  const limit = assertCombinedPageLimit(options.limit);
  return all.slice(offset, offset + limit);
}

/** L3 — plan page count. */
export function planPageCount(plan: readonly DeliveryDecision[], pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize < 1) return 0;
  const n = plan.length;
  if (n === 0) return 0;
  return Math.ceil(n / Math.floor(pageSize));
}

/** L3 — reverse plan decisions. Empty → []. */
export function reversePlanDecisions(plan: readonly DeliveryDecision[]): readonly DeliveryDecision[] {
  return [...plan].reverse();
}

/** L3 — send channels only in left plan. */
export function planSendChannelsOnlyLeft(
  left: readonly DeliveryDecision[],
  right: readonly DeliveryDecision[],
): readonly (MuteableChannel | 'inapp')[] {
  const r = new Set(channelsToSendNow(right));
  return channelsToSendNow(left).filter((c) => !r.has(c));
}

/** L3 — send count delta (left - right). */
export function planSendCountDelta(left: readonly DeliveryDecision[], right: readonly DeliveryDecision[]): number {
  return planSendCount(left) - planSendCount(right);
}

/** L3 — true when plans same length. */
export function plansSameSize(left: readonly DeliveryDecision[], right: readonly DeliveryDecision[]): boolean {
  return left.length === right.length;
}

/** L3 — true when plans have same action multiset sizes (histogram equal). */
export function plansSameActionHistogram(left: readonly DeliveryDecision[], right: readonly DeliveryDecision[]): boolean {
  const a = planActionHistogram(left);
  const b = planActionHistogram(right);
  return a.send_now === b.send_now && a.hold_digest === b.hold_digest && a.skip_muted === b.skip_muted;
}

/** L3 — safe page plan decisions with clamped bounds. */
export function safePagePlanDecisions(plan: readonly DeliveryDecision[], offset: number, limit: number): readonly DeliveryDecision[] {
  if (!Number.isFinite(offset) || !Number.isFinite(limit)) return [];
  const o = Math.max(0, Math.min(plan.length, Math.floor(offset)));
  const l = Math.max(0, Math.min(plan.length - o, Math.floor(limit)));
  return plan.slice(o, o + l);
}

/** L3 — clamp plan page index. */
export function clampPlanPageIndex(plan: readonly DeliveryDecision[], pageIndex: number, pageSize: number): number {
  const pages = planPageCount(plan, pageSize);
  if (pages === 0) return 0;
  if (!Number.isFinite(pageIndex)) return 0;
  return Math.max(0, Math.min(pages - 1, Math.floor(pageIndex)));
}

/** L3 — plan decisions at clamped page. */
export function planDecisionsAtPage(plan: readonly DeliveryDecision[], pageIndex: number, pageSize: number): readonly DeliveryDecision[] {
  if (!Number.isFinite(pageSize) || pageSize < 1) return [];
  const idx = clampPlanPageIndex(plan, pageIndex, pageSize);
  const size = Math.floor(pageSize);
  return safePagePlanDecisions(plan, idx * size, size);
}

/** L3 — true when plan page is valid. */
export function isValidPlanPage(plan: readonly DeliveryDecision[], pageIndex: number, pageSize: number): boolean {
  const pages = planPageCount(plan, pageSize);
  if (pages === 0) return false;
  if (!Number.isFinite(pageIndex)) return false;
  const i = Math.floor(pageIndex);
  return i >= 0 && i < pages;
}

/** L3 — export lines: channel,action. Empty → []. */
export function planExportLines(plan: readonly DeliveryDecision[]): readonly string[] {
  return plan.map((d) => {
    if (d.action === 'inapp_only') return 'inapp,inapp_only';
    return `${d.channel},${d.action}`;
  });
}

/** L3 — plan export header. */
export function planExportHeader(): string {
  return 'channel,action';
}

/** L3 — full plan export text. */
export function planExportText(plan: readonly DeliveryDecision[]): string {
  return [planExportHeader(), ...planExportLines(plan)].join('\n');
}

/** L3 — export line count including header. */
export function planExportLineCount(plan: readonly DeliveryDecision[]): number {
  return 1 + plan.length;
}

/**
 * L3 — parse "channel,action". Invalid → null.
 * inapp_only rows use channel inapp.
 */
export function parsePlanExportLine(line: string): { readonly channel: string; readonly action: string } | null {
  const t = line.trim();
  if (!t || t === planExportHeader()) return null;
  const parts = t.split(',');
  if (parts.length !== 2) return null;
  const channel = parts[0]!.trim();
  const action = parts[1]!.trim();
  if (!channel || !action) return null;
  return { channel, action };
}

/** L3 — count valid plan export data lines. */
export function countPlanExportDataLines(text: string): number {
  return text
    .split('\n')
    .map((l) => parsePlanExportLine(l))
    .filter((r) => r !== null).length;
}

/** L3 — true when plan export has header. */
export function planExportHasHeader(text: string): boolean {
  const first = text.split('\n')[0]?.trim() ?? '';
  return first === planExportHeader();
}

/** L3 — round-trip plan export line count. */
export function planExportRoundTripOk(plan: readonly DeliveryDecision[]): boolean {
  return planExportLineCount(plan) === 1 + countPlanExportDataLines(planExportText(plan));
}

/** L3 — one-line plan status. */
export function planStatusLine(plan: readonly DeliveryDecision[]): string {
  const c = planBoardCard(plan);
  return `total=${c.total} send=${c.send} hold=${c.hold} skip=${c.skip}`;
}

/** L3 — true when plan status is empty. */
export function planStatusLineIsEmpty(plan: readonly DeliveryDecision[]): boolean {
  return planStatusLine(plan).startsWith('total=0');
}

/** L3 — detailed plan status. */
export function planStatusLineDetailed(plan: readonly DeliveryDecision[]): string {
  const c = planBoardCard(plan);
  return `total=${c.total} send=${c.send} hold=${c.hold} skip=${c.skip} mixed=${c.mixed ? '1' : '0'} allSend=${c.allSend ? '1' : '0'}`;
}

/** L3 — token count on detailed plan status. */
export function planStatusLineTokenCount(plan: readonly DeliveryDecision[]): number {
  return planStatusLineDetailed(plan).split(/\s+/).filter(Boolean).length;
}

/** L3 — parse plan status line. Invalid → null. */
export function parsePlanStatusLine(
  line: string,
): { readonly total: number; readonly send: number; readonly hold: number; readonly skip: number } | null {
  const m = line.trim().match(/^total=(\d+) send=(\d+) hold=(\d+) skip=(\d+)$/);
  if (!m) return null;
  return { total: Number(m[1]), send: Number(m[2]), hold: Number(m[3]), skip: Number(m[4]) };
}

/** L3 — true when status line matches plan. */
export function planStatusLineMatches(plan: readonly DeliveryDecision[]): boolean {
  const p = parsePlanStatusLine(planStatusLine(plan));
  if (!p) return false;
  const c = planBoardCard(plan);
  return p.total === c.total && p.send === c.send && p.hold === c.hold && p.skip === c.skip;
}

/** L3 — parse detailed plan status. Invalid → null. */
export function parsePlanStatusLineDetailed(line: string): {
  readonly total: number;
  readonly send: number;
  readonly hold: number;
  readonly skip: number;
  readonly mixed: boolean;
  readonly allSend: boolean;
} | null {
  const m = line.trim().match(/^total=(\d+) send=(\d+) hold=(\d+) skip=(\d+) mixed=([01]) allSend=([01])$/);
  if (!m) return null;
  return {
    total: Number(m[1]),
    send: Number(m[2]),
    hold: Number(m[3]),
    skip: Number(m[4]),
    mixed: m[5] === '1',
    allSend: m[6] === '1',
  };
}

/** L3 — true when send+hold+skip equals total. */
export function planStatusLineConsistent(line: string): boolean {
  const p = parsePlanStatusLine(line);
  if (!p) return false;
  return p.total === p.send + p.hold + p.skip;
}

/** L3 — true when plan total is within [min,max]. Invalid → false. */
export function planTotalInRange(plan: readonly DeliveryDecision[], min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = plan.length;
  return n >= min && n <= max;
}

/** L3 — true when send count is at least n. */
export function planSendCountAtLeast(plan: readonly DeliveryDecision[], n: number): boolean {
  if (!Number.isFinite(n)) return false;
  return planSendCount(plan) >= n;
}

/** L3 — clamp plan page size into [1, total] (empty → 1). */
export function clampPlanPageSize(plan: readonly DeliveryDecision[], pageSize: number): number {
  if (!Number.isFinite(pageSize)) return 1;
  const total = Math.max(1, plan.length);
  return Math.max(1, Math.min(total, Math.floor(pageSize)));
}

/** L3 — true when skip count is at most n. */
export function planSkipCountAtMost(plan: readonly DeliveryDecision[], n: number): boolean {
  if (!Number.isFinite(n)) return false;
  return planSkipCount(plan) <= n;
}

/**
 * Topics the service already writes as the first segment of `kind`
 * (`trade.fill`, `bank.margin_call`, …). A kind outside this list has no
 * per-topic choice.
 */
export const NOTIFY_TOPICS = ['trade', 'p2p', 'identity', 'bank', 'token', 'agents'] as const;
export type NotifyTopic = (typeof NOTIFY_TOPICS)[number];

export function isNotifyTopic(value: string): value is NotifyTopic {
  return (NOTIFY_TOPICS as readonly string[]).includes(value);
}

export function topicFromKind(kind: string): NotifyTopic | null {
  const prefix = kind.split('.')[0] ?? '';
  return isNotifyTopic(prefix) ? prefix : null;
}

/** No stored row means the topic is enabled. `false` is an explicit mute. */
export function topicPrefEnabled(stored: boolean | undefined): boolean {
  return stored !== false;
}
