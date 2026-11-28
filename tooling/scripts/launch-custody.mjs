// The custody switch launch runs with, in one place (#11077). The hosted beta starts its stack with it
// (tooling/beta/beta-host.mjs) and the Real-app journeys run starts each launch-desk shard with it
// (.github/workflows/real-app-journeys.yml), so CI proves the launch desk on the setting the beta and launch run.
// (Failure it prevents: the beta ran custody off from #11019 while every CI journey ran the stack's default, on, so CI
// proved the launch desk on a setup launch won't run, and could pass a step that fails on the beta.)
//
// The launch desk is every Order 1 journey of docs/roadmap/journeys.json (Order 1 is the launch wedge,
// tooling/scripts/roadmap.mjs; a journey marked later for custody is never Order 1). Every other journey is frozen until
// launch and keeps today's setting, the stack's default (local-test-state.mjs startCustodyLayer: on). A file that names no
// journey (menu-reach, registry-blockers) keeps it too, and so does a launch-desk file in NOT_YET_OFF until it is fixed.
// A launch-desk journey's custodial checks (custody on by design, the custodial Later branch) live in its own part file
// named `<journey>-custodial.pw.mjs`, which keeps today's switch too (#11102).
//
// Usage: node tooling/scripts/launch-custody.mjs --files "<journey files>"
// Prints `off` when every file is a launch-desk file, `on` when none is; a mix exits 1, naming the files, since one
// shard runs one stack on one switch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The custody switch (`LEDGER_CUSTODY_LAYER`, as `LOCAL_STACK_CUSTODY_LAYER` on a stack start) launch runs with. */
export const LAUNCH_CUSTODY_LAYER = 'off';
/** The stack's default, which frozen journeys keep (local-test-state.mjs startCustodyLayer with the variable unset). */
export const FROZEN_CUSTODY_LAYER = 'on';
/** The order that is the launch desk in docs/roadmap/journeys.json. */
export const LAUNCH_ORDER = 1;

/**
 * Launch-desk files (by name, less `.pw.mjs`) that still fail with custody off, so they run on today's switch until fixed (#11102). Read from
 * three targeted runs of every Order 1 journey with custody off (45977414925, 45977419967, 45977425153): each file here
 * holds a test that passed on main's run 45972466244 and failed custody off; every other launch-desk file passed whole.
 * The list only shrinks: launch-custody.test.mjs fails an entry that is no launch-desk file, and a file leaves the list
 * once a journeys run shows it passing custody off. Nothing new is added here: a launch-desk file that fails custody off
 * is fixed. Three files left it after #11129, whose failures custody off were only the world restore starting the
 * stack custody on again (svc-ledger then exits on restart): J-derivatives-01-hl-venue, J-derivatives-01-venue and
 * J-derivatives-05, each passing whole custody off in run 46006848956.
 * J-identity-13 and J-identity-22 left it once they stopped funding the person through our ledger (`local:fund`, refused
 * custody off): J-identity-13 holds its TEST money at the TEST partner bank, and J-identity-22 tries its order on the
 * person's own venue account, the launch desk.
 * J-cex-spot-03 left it once its own engine's fill-or-kill and good-till-date checks, which need our own book and a
 * ledger-funded trader, moved to J-cex-spot-03-custodial.pw.mjs (CUSTODIAL_PART).
 * J-p2p-21 and J-wallet-01 joined it in #11159, the one addition: those three runs passed them only because the world
 * restore started their stacks custody on again (#11129 ended that), and both fund their person through our ledger
 * (J-p2p-21's seller, whose sell ad's total svc-p2p checks against a ledger balance; J-wallet-01 #5's retired asset's
 * history), refused custody off. launch-custody.test.mjs now fails any file that runs custody off and funds that way.
 * J-wallet-01 left it once #5 paid its retired coin in at the TEST partner bank and read its history from the partner's
 * own line; today's custodial Deposit and Withdraw pickers moved to J-wallet-01-custodial.pw.mjs (CUSTODIAL_PART).
 * J-derivatives-04 left it once its one custody-on file, three custodial Later tests on our own book that fund a trader
 * through our ledger, became J-derivatives-04-custodial.pw.mjs; all seven steps are proven in J-derivatives-04-venue.pw.mjs.
 * J-derivatives-01 left it the same way: J-derivatives-01.pw.mjs, every test on our own futures book with a trader funded
 * through our ledger, became J-derivatives-01-custodial.pw.mjs; every live step is proven in J-derivatives-01-venue.pw.mjs.
 * J-charts-desk-01 left it the same way: J-charts-desk-01.pw.mjs, every test on our own engine's chart, which has no TEST
 * trades custody off, became J-charts-desk-01-custodial.pw.mjs; all eight steps are proven in J-charts-desk-01-venue.pw.mjs.
 * J-support-public-20-venue left it once #7 stopped funding the customer through our ledger and trading on our own book:
 * their resting order and the refused new one are venue orders through our door, which now refuses a new order while
 * identity holds the account's trading restriction (svc-trade venue/trading-restriction.ts).
 * J-home-ia-11 left it once the stack's status table named the TEST market maker off by design on a custody-off stack
 * (local-test-market.mjs MARKET_OFF_CUSTODY_OFF) and #1 read that row exactly, where it read "not started" as a fault.
 * J-identity-01 left it once #8's trade room became the launch desk, the person's own venue account, and svc-trade's
 * user-venue door held a new order until the email is proved (`trade.email_proof_required`), as our own book does.
 * J-cex-spot-18 left it once its Later steps #3 and #4, a reconcile sweep and a trade bust on our own book with a customer
 * funded through our ledger, moved to J-cex-spot-18-custodial.pw.mjs; #1, #2 and #5 read a routed order on the customer's
 * own venue account, and the customer holds nothing on our ledger.
 * J-cex-spot-10's checks of today's custodial desk moved to J-cex-spot-10-custodial.pw.mjs, and #5 and #8 are proven on
 * the person's own venue account in J-cex-spot-10-venue.pw.mjs. J-cex-spot-10.pw.mjs now holds only #7, which stays here:
 * with our own book off, My tier shows the venue's tier and none of our programme's, so the benefits table and a VIP
 * trial's tier are not shown.
 */
export const NOT_YET_OFF = new Set([
  'J-agents-01',
  'J-agents-02',
  'J-agents-08',
  'J-cex-spot-10',
  'J-cex-spot-15-algo',
  'J-cex-spot-15-api',
  'J-charts-desk-14',
  'J-derivatives-02',
  'J-derivatives-06',
  'J-home-ia-01',
  'J-ops-console-02-customer-record',
  'J-p2p-21',
  'J-portfolio-01',
  'J-portfolio-03',
  'J-support-public-20',
]);

/** A launch-desk part file of custodial checks (custody on by design): `<journey>-custodial.pw.mjs` keeps today's switch. */
export const CUSTODIAL_PART = /-custodial\.pw\.mjs$/;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const JOURNEYS_JSON = path.join(ROOT, 'docs/roadmap/journeys.json');
// A journey file's id ends at its first number; a part file adds a suffix (journey-seal.mjs JOURNEY_TEST).
const JOURNEY_FILE_ID = /^(?:.*\/)?(J-[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\d+)(?:-[a-z0-9-]+)?\.pw\.mjs$/;

/** The journey id a journey file runs, or null for a file that names none. */
export function journeyIdOf(file) {
  return JOURNEY_FILE_ID.exec(String(file))?.[1] ?? null;
}

/** The ids of the launch-desk journeys (LAUNCH_ORDER) in a journeys.json list. Pure, for the tests. */
export function launchJourneyIds(journeys) {
  if (!Array.isArray(journeys) || journeys.length === 0) throw new Error('journeys.json holds no journey');
  return new Set(journeys.filter((j) => j?.order === LAUNCH_ORDER).map((j) => j.id));
}

/** The launch-desk ids from docs/roadmap/journeys.json. */
export function readLaunchJourneyIds(file = JOURNEYS_JSON) {
  return launchJourneyIds(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/**
 * The custody switch a journey file's stack runs: LAUNCH_CUSTODY_LAYER for a launch-desk journey's file, else today's,
 * and today's for a launch-desk file still in `notYet` (NOT_YET_OFF) or a custodial part file (CUSTODIAL_PART).
 */
export function fileCustody(file, launchIds, notYet = NOT_YET_OFF) {
  const name = String(file)
    .split('/')
    .pop()
    .replace(/\.pw\.mjs$/, '');
  return launchIds.has(journeyIdOf(file)) && !notYet.has(name) && !CUSTODIAL_PART.test(String(file))
    ? LAUNCH_CUSTODY_LAYER
    : FROZEN_CUSTODY_LAYER;
}

/** The one switch a shard of `files` runs; throws naming both kinds when they mix. Pure, for the tests. */
export function shardCustody(files, launchIds) {
  const list = files.filter(Boolean);
  if (list.length === 0) throw new Error('a shard with no journey file has no custody switch');
  const by = Map.groupBy(list, (f) => fileCustody(f, launchIds));
  if (by.size > 1)
    throw new Error(
      `one shard mixes custody ${LAUNCH_CUSTODY_LAYER} (${by.get(LAUNCH_CUSTODY_LAYER).join(' ')}) and ${FROZEN_CUSTODY_LAYER} (${by.get(FROZEN_CUSTODY_LAYER).join(' ')}); the shard planner keeps them apart (journey-shards.mjs)`,
    );
  return [...by.keys()][0];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--files');
  if (i < 0) {
    console.error('usage: node tooling/scripts/launch-custody.mjs --files "<journey files>"');
    process.exit(2);
  }
  try {
    process.stdout.write(`${shardCustody(String(argv[i + 1] ?? '').split(/\s+/), readLaunchJourneyIds())}\n`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
