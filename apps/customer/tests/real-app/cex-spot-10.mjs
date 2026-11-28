import { expect } from './journey.mjs';
import { approverSessions, makeContext, setFeeSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE } from './stack.mjs';

// J-cex-spot-10's TEST fee schedules and the two-operator door that writes them, shared by J-cex-spot-10.pw.mjs (our
// tier programme and VIP benefits, custody off) and J-cex-spot-10-custodial.pw.mjs (today's custodial desk, custody on).
const J = 'J-cex-spot-10';

/** TEST rates through the real write path, not owner decisions. A TEST VIP tier lowers both rates. */
export const REGULAR = { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null };
export const VIP = { pairGroup: 'all-others', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null };
export const ZERO = { pairGroup: 'test-zero-fee', tierId: 'regular', zeroFee: true, minFee: null };
/**
 * A stored version replaces the stack's boot schedule for every later order, futures too, so it carries the stack's own
 * perpetual block (tooling/scripts/local-stack-services/trade.mjs) unchanged.
 */
export const SCHEDULE = {
  defaultPairGroup: 'all-others',
  pairGroups: { 'ETH/USDC': 'test-zero-fee' },
  rows: [REGULAR, VIP, ZERO],
  perpetual: { makerBps: '2', takerBps: '5' },
};
/** TEST threshold, not an owner value: 1,000 of counted volume over 30 days puts an account on the TEST VIP tier. */
export const VIP_FROM = '1000';
/**
 * SCHEDULE with a TEST tier programme whose daily snapshot runs at `snapshotAt`'s minute (UTC). A programme needs a row
 * for each of its tiers in every pair group, so the zero-fee group gains the TEST VIP tier, still at zero fee.
 */
export const tiersAt = (snapshotAt) => ({
  ...SCHEDULE,
  rows: [...SCHEDULE.rows, { ...ZERO, tierId: 'test-vip-1' }],
  tierProgram: {
    thresholds: [{ tierId: 'test-vip-1', minVolume30d: VIP_FROM }],
    volumeQuotes: ['USDT', 'USDC'],
    snapshotTimeUtc: snapshotAt.toISOString().slice(11, 16),
    downgradeGraceDays: null,
    subAccounts: null,
    botsAndCopy: null,
  },
});

export const published = async () => {
  const res = await fetch(`${EDGE}/api/v1/fees/published`);
  return { status: res.status, body: await res.json() };
};

/** The stack's two TEST operators, signed in once for the file. */
let operators;
export async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

/**
 * Write `schedule` as the next version, effective in ten seconds or just after `after` (a version already stored to
 * take effect later, since svc-trade refuses one that would start before it), and wait until the public read serves it.
 */
export async function publish(schedule, reason, after = null) {
  const { ctx, sessions } = await ops();
  const effectiveAt = Math.max(Date.now() + 10_000, after ? Date.parse(after) + 5_000 : 0);
  const row = await setFeeSchedule(ctx, schedule, { effectiveAt, reason: `LOCAL TEST ${J}: ${reason}`, sessions });
  await expect.poll(async () => (await published()).body.version, { timeout: 30_000 }).toBe(`v${row.version}`);
  return row;
}

/** The TEST tier programme, its snapshot on the first whole minute at least `leadMs` from now. */
export async function publishTiers(leadMs, reason) {
  const snapshotAt = new Date(Math.ceil((Date.now() + leadMs) / 60_000) * 60_000);
  const row = await publish(tiersAt(snapshotAt), reason);
  return { version: `v${row.version}`, snapshotAt };
}

/** The account's own fee tier read, as My tier shows it. */
export async function myTier(client) {
  const { status, body } = await client.get('/api/v1/account/fee-tier');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}
