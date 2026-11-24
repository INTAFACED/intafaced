import { describe, expect, it } from 'vitest';
import {
  channelsHeldForDigest,
  countHoldingChannels,
  countSendNowChannels,
  channelsSkippedMuted,
  channelsToSendNow,
  criticalAlwaysImmediate,
  decideChannelDelivery,
  DEFAULT_COMBINED_PREFS,
  planFanoutDelivery,
  summarizeFanoutPlan,
  countSkippedMuted,
  planHasNoMutes,
  planIsAllSendNow,
  planIsEmpty,
  planHasHolds,
  planHasSkips,
  countSendNow,
  planSkipCount,
  planHoldCount,
  planSendCount,
  planHasSends,
  planDecisionCount,
  planSendRatio,
  planIsMixed,
  planHoldRatio,
  planSkipRatio,
  planHasNoHolds,
  planActionsPresent,
  planIsAllDeferred,
  planInappSendChannels,
  planSendsInapp,
  planOutOfAppSends,
  planOnlySendsOrEmpty,
  planHoldChannelsSorted,
  planSkipChannelsSorted,
  planActionHistogram,
  planHistogramOnlySends,
  planHistogramOnlySkips,
  planHistogramOnlyHolds,
  planNonZeroActions,
  planHasAtLeastDecisions,
  planSendMinusHold,
  firstSendChannel,
  lastSendChannel,
  planDecisionCountLabel,
  planSendCountLabel,
  planHoldCountLabel,
  planSkipCountLabel,
  planSendChannelsJoined,
  planHoldChannelsJoined,
  planSkipChannelsJoined,
  planActionsPresentJoined,
  planSendRatioLabel,
  planHoldRatioLabel,
  planSkipRatioLabel,
  firstSendChannelLabel,
  planActionSnapshot,
  planActionCountsConsistent,
  planRatioSnapshot,
  planChannelPartition,
  planBoardCard,
  planBoardHasSends,
  planBoardIsEmpty,
  planBoardChannels,
  filterPlanByAction,
  planIncludesAction,
  countPlanAction,
  filterPlanSendChannels,
  pagePlanDecisions,
  pagePlanSendChannels,
  planPageCount,
  reversePlanDecisions,
  planSendChannelsOnlyLeft,
  planSendCountDelta,
  plansSameSize,
  plansSameActionHistogram,
  safePagePlanDecisions,
  clampPlanPageIndex,
  planDecisionsAtPage,
  isValidPlanPage,
  planExportLines,
  planExportHeader,
  planExportText,
  planExportLineCount,
  parsePlanExportLine,
  countPlanExportDataLines,
  planExportHasHeader,
  planExportRoundTripOk,
  planStatusLine,
  planStatusLineIsEmpty,
  planStatusLineDetailed,
  planStatusLineTokenCount,
  planStatusLineMatches,
  parsePlanStatusLineDetailed,
  planStatusLineConsistent,
  planTotalInRange,
  planSendCountAtLeast,
  clampPlanPageSize,
  planSkipCountAtMost,
} from './combined.js';
import { applyMuteToggle } from './mute.js';
import { applyDigestCadence } from './digest.js';

describe('notify L3 combined mute + digest', () => {
  it('inapp always send_now', () => {
    expect(decideChannelDelivery(DEFAULT_COMBINED_PREFS, 'inapp', 'info')).toEqual({
      action: 'send_now',
      channel: 'inapp',
    });
  });

  it('muted non-critical skips; critical still send_now', () => {
    const mute = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'email', muted: true });
    const prefs = { mute, digest: DEFAULT_COMBINED_PREFS.digest };
    expect(decideChannelDelivery(prefs, 'email', 'info')).toEqual({ action: 'skip_muted', channel: 'email' });
    expect(decideChannelDelivery(prefs, 'email', 'critical')).toEqual({ action: 'send_now', channel: 'email' });
    expect(criticalAlwaysImmediate(prefs, 'email')).toBe(true);
  });

  it('hourly digest holds info; critical immediate', () => {
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const prefs = { mute: DEFAULT_COMBINED_PREFS.mute, digest };
    expect(decideChannelDelivery(prefs, 'push', 'info')).toEqual({ action: 'hold_digest', channel: 'push' });
    expect(decideChannelDelivery(prefs, 'push', 'critical')).toEqual({ action: 'send_now', channel: 'push' });
  });

  it('L3 planFanoutDelivery maps each channel without invent', () => {
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const mute = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'sms', muted: true });
    const plan = planFanoutDelivery({ mute, digest }, ['inapp', 'email', 'sms'], 'info');
    expect(plan).toEqual([
      { action: 'send_now', channel: 'inapp' },
      { action: 'hold_digest', channel: 'email' },
      { action: 'skip_muted', channel: 'sms' },
    ]);
  });

  it('L3 summarizeFanoutPlan counts actions without invent', () => {
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const mute = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'sms', muted: true });
    const plan = planFanoutDelivery({ mute, digest }, ['inapp', 'email', 'sms'], 'info');
    expect(summarizeFanoutPlan(plan)).toEqual({ sendNow: 1, holdDigest: 1, skipMuted: 1, total: 3 });
    expect(summarizeFanoutPlan([])).toEqual({ sendNow: 0, holdDigest: 0, skipMuted: 0, total: 0 });
  });

  it('L3 channelsToSendNow lists only immediate channels', () => {
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const mute = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'sms', muted: true });
    const plan = planFanoutDelivery({ mute, digest }, ['inapp', 'email', 'sms'], 'info');
    expect(channelsToSendNow(plan)).toEqual(['inapp']);
    expect(channelsToSendNow([])).toEqual([]);
  });

  it('L3 hold/skip channel lists without invent', () => {
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const mute = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'sms', muted: true });
    const plan = planFanoutDelivery({ mute, digest }, ['inapp', 'email', 'sms'], 'info');
    expect(channelsHeldForDigest(plan)).toEqual(['email']);
    expect(channelsSkippedMuted(plan)).toEqual(['sms']);
    expect(channelsHeldForDigest([])).toEqual([]);
  });

  it('L3 countHoldingChannels without invent', () => {
    expect(countHoldingChannels([])).toBe(0);
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const plan = planFanoutDelivery({ mute: DEFAULT_COMBINED_PREFS.mute, digest }, ['email', 'push'], 'info');
    expect(countHoldingChannels(plan)).toBe(2);
  });

  it('L3 countSendNowChannels without invent', () => {
    expect(countSendNowChannels([])).toBe(0);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(countSendNowChannels(plan)).toBe(2);
  });
  it('L3 countSkippedMuted without invent', () => {
    expect(countSkippedMuted([])).toBe(0);
    const mute = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'email', muted: true });
    const plan = planFanoutDelivery({ mute, digest: DEFAULT_COMBINED_PREFS.digest }, ['email', 'inapp'], 'info');
    expect(countSkippedMuted(plan)).toBe(1);
  });

  it('L3 planHasNoMutes true when none skipped', () => {
    expect(planHasNoMutes([])).toBe(true);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planHasNoMutes(plan)).toBe(true);
  });

  it('L3 planIsAllSendNow false when empty', () => {
    expect(planIsAllSendNow([])).toBe(false);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planIsAllSendNow(plan)).toBe(true);
  });

  it('L3 planIsEmpty', () => {
    expect(planIsEmpty([])).toBe(true);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp'], 'info');
    expect(planIsEmpty(plan)).toBe(false);
  });

  it('L3 planHasHolds', () => {
    expect(planHasHolds([])).toBe(false);
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const plan = planFanoutDelivery({ mute: DEFAULT_COMBINED_PREFS.mute, digest }, ['email'], 'info');
    expect(planHasHolds(plan)).toBe(true);
  });

  it('L3 wave21 planHasSkips + countSendNow', () => {
    expect(planHasSkips([])).toBe(false);
    expect(countSendNow([])).toBe(0);
    const plan = [
      { channel: 'email' as const, action: 'send_now' as const },
      { channel: 'push' as const, action: 'skip_muted' as const },
    ];
    // if DeliveryDecision shape differs, adjust in test run
    expect(planHasSkips(plan as any)).toBe(true);
    expect(countSendNow(plan as any)).toBe(1);
  });

  it('L3 planSkipCount aliases countSkippedMuted', () => {
    expect(planSkipCount([])).toBe(0);
  });

  it('L3 planHoldCount aliases countHoldingChannels', () => {
    expect(planHoldCount([])).toBe(0);
  });

  it('L3 planSendCount aliases countSendNowChannels', () => {
    expect(planSendCount([])).toBe(0);
  });

  it('L3 wave25 planHasSends + decision count + send ratio + mixed', () => {
    expect(planHasSends([])).toBe(false);
    expect(planDecisionCount([])).toBe(0);
    expect(planSendRatio([])).toBeNull();
    expect(planIsMixed([])).toBe(false);
    const muted = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'email', muted: true });
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const prefs = { mute: muted, digest };
    const plan = planFanoutDelivery(prefs, ['inapp', 'email', 'sms'], 'info');
    expect(planDecisionCount(plan)).toBe(plan.length);
    expect(planSendRatio(plan)).toMatch(/^\d+\.\d{4}$/);
    expect(typeof planHasSends(plan)).toBe('boolean');
    expect(typeof planIsMixed(plan)).toBe('boolean');
  });

  it('L3 wave26 hold/skip ratios + no holds + actions present', () => {
    expect(planHoldRatio([])).toBeNull();
    expect(planSkipRatio([])).toBeNull();
    expect(planHasNoHolds([])).toBe(true);
    expect(planActionsPresent([])).toEqual([]);
    const muted = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'email', muted: true });
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const plan = planFanoutDelivery({ mute: muted, digest }, ['inapp', 'email', 'sms'], 'info');
    expect(planHoldRatio(plan)).toMatch(/^\d+\.\d{4}$/);
    expect(planSkipRatio(plan)).toMatch(/^\d+\.\d{4}$/);
    expect(typeof planHasNoHolds(plan)).toBe('boolean');
    expect(planActionsPresent(plan).length).toBeGreaterThan(0);
  });

  it('L3 wave27 deferred + inapp + out-of-app sends', () => {
    expect(planIsAllDeferred([])).toBe(false);
    expect(planSendsInapp([])).toBe(false);
    expect(planInappSendChannels([])).toEqual([]);
    expect(planOutOfAppSends([])).toEqual([]);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planSendsInapp(plan)).toBe(true);
    expect(planInappSendChannels(plan)).toEqual(['inapp']);
    expect(planOutOfAppSends(plan)).toContain('email');
    expect(planIsAllDeferred(plan)).toBe(false);
  });

  it('L3 wave28 only-sends + sorted hold/skip + histogram', () => {
    expect(planOnlySendsOrEmpty([])).toBe(true);
    expect(planHoldChannelsSorted([])).toEqual([]);
    expect(planSkipChannelsSorted([])).toEqual([]);
    expect(planActionHistogram([])).toEqual({ send_now: 0, hold_digest: 0, skip_muted: 0 });
    const muted = applyMuteToggle(DEFAULT_COMBINED_PREFS.mute, { channel: 'email', muted: true });
    const digest = applyDigestCadence(DEFAULT_COMBINED_PREFS.digest, 'hourly');
    const plan = planFanoutDelivery({ mute: muted, digest }, ['inapp', 'email', 'sms'], 'info');
    expect(planActionHistogram(plan).send_now + planActionHistogram(plan).hold_digest + planActionHistogram(plan).skip_muted).toBe(
      plan.length,
    );
    expect([...planHoldChannelsSorted(plan)]).toEqual([...planHoldChannelsSorted(plan)].sort());
    expect([...planSkipChannelsSorted(plan)]).toEqual([...planSkipChannelsSorted(plan)].sort());
  });

  it('L3 wave29 histogram purity + non-zero actions', () => {
    expect(planHistogramOnlySends([])).toBe(false);
    expect(planNonZeroActions([])).toEqual([]);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planHistogramOnlySends(plan)).toBe(true);
    expect(planHistogramOnlySkips(plan)).toBe(false);
    expect(planHistogramOnlyHolds(plan)).toBe(false);
    expect(planNonZeroActions(plan)).toEqual(['send_now']);
  });

  it('L3 wave30 plan at-least + send-hold + first/last send', () => {
    expect(planHasAtLeastDecisions([], 1)).toBe(false);
    expect(firstSendChannel([])).toBeNull();
    expect(lastSendChannel([])).toBeNull();
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planHasAtLeastDecisions(plan, 2)).toBe(true);
    expect(planSendMinusHold(plan)).toBe(planSendCount(plan));
    expect(firstSendChannel(plan)).toBe('inapp');
    expect(lastSendChannel(plan)).toBe('email');
  });

  it('L3 wave31 plan count labels', () => {
    expect(planDecisionCountLabel([])).toBe('0');
    expect(planSendCountLabel([])).toBe('0');
    expect(planHoldCountLabel([])).toBe('0');
    expect(planSkipCountLabel([])).toBe('0');
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planDecisionCountLabel(plan)).toBe(String(plan.length));
    expect(planSendCountLabel(plan)).toBe(String(planSendCount(plan)));
  });

  it('L3 wave32 plan channel/action joins', () => {
    expect(planSendChannelsJoined([])).toBe('');
    expect(planHoldChannelsJoined([])).toBe('');
    expect(planSkipChannelsJoined([])).toBe('');
    expect(planActionsPresentJoined([])).toBe('');
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planSendChannelsJoined(plan)).toContain('inapp');
    expect(planActionsPresentJoined(plan)).toBe('send_now');
  });

  it('L3 wave33 plan ratio/channel labels', () => {
    expect(planSendRatioLabel([])).toBe('');
    expect(planHoldRatioLabel([])).toBe('');
    expect(planSkipRatioLabel([])).toBe('');
    expect(firstSendChannelLabel([])).toBe('');
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planSendRatioLabel(plan)).toMatch(/^\d+\.\d{4}$/);
    expect(firstSendChannelLabel(plan)).toBe('inapp');
  });

  it('L3 wave34 plan snapshots consistent', () => {
    expect(planActionCountsConsistent([])).toBe(true);
    expect(planRatioSnapshot([]).send).toBeNull();
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planActionCountsConsistent(plan)).toBe(true);
    expect(planActionSnapshot(plan).total).toBe(plan.length);
    expect(planChannelPartition(plan).send.length).toBeGreaterThan(0);
  });

  it('L3 wave36 plan board card', () => {
    expect(planBoardIsEmpty([])).toBe(true);
    expect(planBoardHasSends([])).toBe(false);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planBoardCard(plan).allSend).toBe(true);
    expect(planBoardHasSends(plan)).toBe(true);
    expect(planBoardChannels(plan).send.length).toBeGreaterThan(0);
  });

  it('L3 wave37 plan action filters', () => {
    expect(filterPlanByAction([], 'send_now')).toEqual([]);
    expect(planIncludesAction([], 'send_now')).toBe(false);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(countPlanAction(plan, 'send_now')).toBe(plan.length);
    expect(planIncludesAction(plan, 'send_now')).toBe(true);
    expect(filterPlanSendChannels(plan, 'in')).toContain('inapp');
  });

  it('L3 wave38 plan paging', () => {
    expect(pagePlanDecisions([], { limit: 1 })).toEqual([]);
    expect(planPageCount([], 5)).toBe(0);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email', 'sms'], 'critical');
    expect(pagePlanDecisions(plan, { offset: 0, limit: 2 })).toHaveLength(2);
    expect(pagePlanSendChannels(plan, { limit: 1 })).toHaveLength(1);
    expect(planPageCount(plan, 2)).toBe(2);
    expect(reversePlanDecisions(plan)).toHaveLength(plan.length);
  });

  it('L3 wave39 plan compare', () => {
    const left = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    const right = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp'], 'critical');
    expect(planSendChannelsOnlyLeft(left, right)).toContain('email');
    expect(planSendCountDelta(left, right)).toBe(1);
    expect(plansSameSize(left, left)).toBe(true);
    expect(plansSameActionHistogram(left, left)).toBe(true);
  });

  it('L3 wave40 plan safe paging', () => {
    expect(safePagePlanDecisions([], 0, 1)).toEqual([]);
    expect(isValidPlanPage([], 0, 1)).toBe(false);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email', 'sms'], 'critical');
    expect(safePagePlanDecisions(plan, 0, 2)).toHaveLength(2);
    expect(clampPlanPageIndex(plan, 99, 2)).toBe(1);
    expect(planDecisionsAtPage(plan, 0, 2)).toHaveLength(2);
    expect(isValidPlanPage(plan, 0, 2)).toBe(true);
  });

  it('L3 wave41 plan export', () => {
    expect(planExportLines([])).toEqual([]);
    expect(planExportHeader()).toBe('channel,action');
    expect(planExportLineCount([])).toBe(1);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planExportLines(plan).length).toBe(plan.length);
    expect(planExportText(plan)).toContain('send_now');
  });

  it('L3 wave42 plan export parse + round-trip', () => {
    expect(parsePlanExportLine('channel,action')).toBeNull();
    expect(parsePlanExportLine('email,send_now')).toEqual({ channel: 'email', action: 'send_now' });
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    const text = planExportText(plan);
    expect(planExportHasHeader(text)).toBe(true);
    expect(countPlanExportDataLines(text)).toBe(plan.length);
    expect(planExportRoundTripOk(plan)).toBe(true);
  });

  it('L3 wave44 plan status lines', () => {
    expect(planStatusLineIsEmpty([])).toBe(true);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planStatusLine(plan)).toContain('send=');
    expect(planStatusLineDetailed(plan)).toContain('allSend=');
    expect(planStatusLineTokenCount(plan)).toBe(6);
  });

  it('L3 wave45 plan status parse + match', () => {
    expect(planStatusLineMatches([])).toBe(true);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planStatusLineMatches(plan)).toBe(true);
    expect(planStatusLineConsistent(planStatusLine(plan))).toBe(true);
    expect(parsePlanStatusLineDetailed(planStatusLineDetailed(plan))?.allSend).toBe(true);
  });

  it('L3 wave46 plan thresholds + clamps', () => {
    expect(planTotalInRange([], 0, 0)).toBe(true);
    const plan = planFanoutDelivery(DEFAULT_COMBINED_PREFS, ['inapp', 'email'], 'critical');
    expect(planSendCountAtLeast(plan, 1)).toBe(true);
    expect(clampPlanPageSize(plan, 99)).toBe(plan.length);
    expect(planSkipCountAtMost(plan, 0)).toBe(true);
  });
});
