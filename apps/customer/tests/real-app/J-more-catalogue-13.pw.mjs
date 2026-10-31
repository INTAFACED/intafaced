import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { createEvent, moveEvent, onboardedIssuer } from './launch.mjs';

// J-more-catalogue-13, in the running app (docs/roadmap/journeys.json): stake in a launch pool and see my distribution
// schedule. One test per step, titled "J-more-catalogue-13 #<n>", run in order. The launches are made through svc-token's
// own founder doors, each with a two-founder approval, and every figure on screen is checked against svc-token's read.
// Steps whose slice is not built fail by name, cheaply:
// - MC-launch-04 (#1 to #3): no launch pool, warming period, pool stake recipes or new-token event registration.
// Every name, date and amount here is TEST.
const J = 'J-more-catalogue-13';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const DAY = 86_400_000;
const MINUTE = 60_000;
const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;

test.describe.configure({ mode: 'default' });

/** A step whose slice is not built: fails at once, naming the slice and what is missing. */
function notBuilt(slice, missing) {
  return async () => {
    test.setTimeout(5_000);
    throw new Error(`${slice} is not built: ${missing}`);
  };
}

/** The run's saved start, or a named failure when the step that writes it did not run. */
function started() {
  const saved = run.read();
  if (!saved.who || !saved.launches) throw new Error(`${J} start did not build the account and the launches, so this step cannot run`);
  return saved;
}

/** One launch's schedule as svc-token publishes it, read signed out through Edge. */
async function schedule(id) {
  const res = await fetch(`${EDGE}/api/token/trpc/launch.events.schedule${trpcInput({ id })}`, { headers: { origin: ORIGIN } });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** The launch page's distribution panel. */
async function openDistribution(page, launch) {
  await page.goto(`/launch/${launch.id}`);
  await expect(page.getByRole('heading', { name: launch.label })).toBeVisible();
  const panel = page.getByTestId('launch-distribution');
  await expect(panel.getByRole('heading', { name: 'Distribution', level: 3 })).toBeVisible();
  return panel;
}

test(`${J} starts: signed in, funded with TEST money; a launch with a vesting schedule`, async ({ page }) => {
  test.setTimeout(300_000);
  const tag = Date.now().toString(36);
  const issuer = await onboardedIssuer(`tst-issuer-${tag}`, `TEST Issuer ${tag}`);
  const who = await signUp(page, 'lv');
  await verify(page, who);
  expect(fund(who.email, 'IFC', '100').tx).toBeTruthy();

  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  // Each launch is announced, so it is published; the schedules put "now" before, inside and after vesting.
  const launch = (key, vesting) => ({
    id: `tst-${key}-${tag}`,
    issuerId: issuer.id,
    type: 'token_sale',
    projectName: `TEST ${key} vesting ${tag}`,
    symbol: 'TSTV',
    periods: {
      announceAt: at(now - MINUTE),
      snapshotAt: at(now + DAY),
      openAt: at(now + 2 * DAY),
      closeAt: at(now + 3 * DAY),
      distributionAt: at(now + 4 * DAY),
    },
    allocation: { method: 'pro_rata', perUserCap: '250', ticketSize: null, tierWeights: null },
    terms: { price: '0.5', paymentAsset: 'USDT', rateSource: null },
    vesting,
  });
  const launches = {
    unset: launch('unset', null),
    before: launch('before', { startAt: at(now + 10 * DAY), cliffAt: null, endAt: at(now + 20 * DAY) }),
    halfway: launch('halfway', { startAt: at(now - 100 * DAY), cliffAt: at(now - 50 * DAY), endAt: at(now + 100 * DAY) }),
    ended: launch('ended', { startAt: at(now - 20 * DAY), cliffAt: null, endAt: at(now - 10 * DAY) }),
  };
  for (const e of Object.values(launches)) {
    const revision = await createEvent(e);
    await moveEvent(e.id, 'announced', revision);
  }
  const saved = Object.fromEntries(Object.entries(launches).map(([k, e]) => [k, { id: e.id, label: `${e.projectName} (${e.symbol})` }]));
  run.reset({ who, launches: saved });
  for (const [key, e] of Object.entries(launches)) {
    const read = await schedule(e.id);
    expect(read.reason, key).toBe(e.vesting ? null : 'launch.schedule_unset');
  }
  await signIn(page, who);
});

test(
  `${J} #1 Joins the pool and stakes: the hold posts once; state "pending start" until the warming period ends, then "mining"; a blank warming period refuses`,
  notBuilt('MC-launch-04', 'there is no launch pool, no warming period and no pool stake recipe (launchPoolStake)'),
);

test(
  `${J} #2 Stakes twice and unstakes part: stake-seconds follow stored events; unstake releases once`,
  notBuilt('MC-launch-04', 'there is no launch pool stake or unstake, so no stake-seconds are stored'),
);

test(
  `${J} #3 Registers for the new-token event twice: one registration; qualification shown`,
  notBuilt('MC-launch-04', 'there is no new-token event registration (launch.events.register) or qualification read'),
);

test(`${J} #4 Opens the distribution schedule: "schedule not set" with no invented date; or vested zero before start, half at halfway of a linear period, full at the end`, async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { who, launches } = started();
  await signIn(page, who);

  const unset = await openDistribution(page, launches.unset);
  await expect(unset.getByTestId('launch-schedule-unset')).toHaveText(/^Schedule not set/);
  await expect(unset.locator('time')).toHaveCount(0);
  await expect(unset.getByTestId('launch-vested-share')).toHaveCount(0);

  for (const [key, expected] of [
    ['before', { stage: 'Not started', percent: 0 }],
    ['halfway', { stage: 'Vesting', percent: 50 }],
    ['ended', { stage: 'Fully vested', percent: 100 }],
  ]) {
    const panel = await openDistribution(page, launches[key]);
    const served = await schedule(launches[key].id);
    const shown = Number((await panel.getByTestId('launch-vested-share').innerText()).replace(/% of any allocation$/, ''));
    // The page and this read are a few seconds apart: the share moves well under 0.01% in that time.
    expect(Math.abs(shown - Number(served.vestedShare) * 100), `${key}: page ${shown}%, service ${served.vestedShare}`).toBeLessThanOrEqual(
      0.02,
    );
    expect(Math.abs(shown - expected.percent), `${key} is about ${expected.percent}%`).toBeLessThanOrEqual(0.1);
    await expect(panel.getByRole('definition').filter({ hasText: new RegExp(`^${expected.stage}$`) })).toHaveCount(1);
    await expect(panel.getByTestId('launch-awarded')).toHaveText(/^Your allocation: none awarded\./);
  }
});

test(`${J} #5 Presses the on-chain claim: the typed refusal naming the first failing Protocol blocker`, async ({ page }) => {
  test.setTimeout(60_000);
  const { who, launches } = started();
  await signIn(page, who);
  const panel = await openDistribution(page, launches.halfway);
  await panel.getByRole('button', { name: 'Claim on chain' }).click();
  const refusal = panel.getByTestId('launch-claim-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'launch.chain_claim_unavailable');
  await expect(refusal).toHaveText(/^An on-chain claim is not available: the project token is not issued on a chain/);
  await panel.getByRole('button', { name: 'Claim to my account' }).click();
  await expect(refusal).toHaveAttribute('data-code', 'launch.claim_unavailable');
});
