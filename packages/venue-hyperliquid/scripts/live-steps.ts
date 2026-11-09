/**
 * LIVE TESTNET JOURNEY STEPS — run by hand, never in CI.
 *
 *   APP_ENV=test HL_TESTNET_KEY_FILE=/path/to/keys.json \
 *     pnpm --filter @intafaced/venue-hyperliquid live:steps [--out ./live-steps-evidence.json]
 *
 * B1's outside check (project-state #1789): the venue side of the steps that `J-cex-spot-01-venue.pw.mjs` and
 * `J-derivatives-01-venue.pw.mjs` drive on the simulator, run once on the Hyperliquid TESTNET through the same
 * `UserVenue` calls svc-trade's venue door makes: preview, prepare, sign with the key, submit, read back.
 *   · J-cex-spot-01 #6 #7 #8 #9 #10 #12;
 *   · J-derivatives-01 #1 #5 #6 #7 #8 #9 #11.
 * What each step checks is written beside it below. The desk's own screens, and the app's own refusals (step-up, the
 * margin-asset refusal), are the journey files' to prove; a step's part that only the app can show is listed as
 * skipped with that reason, never passed.
 *
 * A live account is not the simulator's fresh one, so every check reads CHANGES in the venue's own balances and
 * records, never absolute balances. Orders are sized at the smallest valid lot worth just over the venue's minimum
 * order value (`sizeForValue`, live-settings.ts). Client ids are business keys, `live:<step>:<run id>`, the run id
 * from the clock.
 *
 * The spot fill (#8) crosses the trader's resting buy with the "other" key: the step says the resting order fills as
 * maker, and the live book's makers do not hit a bid on demand, while a marketable order from the trader would make
 * the trader the taker. "other" sells into the trader's bid with an IOC at the trader's price; when it holds too little
 * of the base, it first buys it from the live book (an IOC buy), funded by a `usdSend` from the trader and its own
 * `usdClassTransfer` to spot.
 *
 * Our builder fee is a TEST 0.5 bps to the "third" key's address (the real builder address is an owner value and is
 * not used). The venue only lets an account approve a builder that holds 100 USDC of perps account value
 * (Hyperliquid docs, "Builder codes"), so the trader tops "third" up with `usdSend` first when it needs the approval.
 *
 * Nothing is left open: every order this run placed that is still resting is cancelled, and the perp position it
 * opened is closed, in a `finally`, after a failure too. The run prints one line per step (PASS, FAIL or SKIPPED, with
 * the venue's evidence) and writes the same as JSON to `--out` (default `./live-steps-evidence.json`). A key is read
 * into memory from `HL_TESTNET_KEY_FILE` and used to sign; it is never printed, logged or written. Only addresses are.
 *
 * Optional settings, each worked out from the live testnet when unset:
 *   HL_SPOT_SYMBOL  the first USDC spot pair (by symbol) with room strictly inside its spread;
 *   HL_SPOT_PRICE   the trader's resting buy (#7), strictly inside the spread;
 *   HL_PERP_SYMBOL  ETH-PERP;
 *   HL_WITHDRAW_AMOUNT  2 (USDC-PERP; the venue takes its fee out of it).
 *
 * probe:agent-cannot-move-funds (for J-agents-21; B2's ask on project-state #1671): Hyperliquid's docs do not say plainly
 * that an agent key cannot move funds, so the venue is asked. The trader approves the key file's `agent` key (owner
 * signed, through the adapter; skipped when the venue already lists it), and the agent key then signs `withdraw3`,
 * `usdSend`, `spotSend` and `sendAsset`, each moving a small amount to the agent's own address. The raw actions go
 * straight to `/exchange`, never through `UserVenue.prepare`, whose own guard (`assertSignerMaySign`) would refuse them
 * before the venue is asked. A user-signed action acts on the account that signed it, so a refusal alone may only mean
 * the agent's own account is empty: PASS needs each answer to be a refusal (recorded verbatim, with what its wording
 * suggests) AND the trader's spot and perp balances, read before and after, unchanged. An accepted action is a loud
 * FAIL that names it. `agentSendAsset` is not in the pinned SDK, so that part is SKIPPED, never guessed. The pinned
 * SDK has no form to revoke an agent, so an agent the probe approved stays approved, and the run says so.
 * It runs after the perp close in the full run, or alone with `--probe agent-funds` (keys `trader` and `agent` only).
 *
 * Exit codes: 0 no step failed, 1 a step failed or something was left open, 2 refused before anything was sent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { abs, add, compare, div, formatAmount, max, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  venueClientOrderId,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type UserVenueBalance,
  type UserVenueFill,
  type UserVenueMarket,
  type VenueIntent,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import {
  HL_TESTNET_API_URL,
  HL_TESTNET_VENUE_ID,
  HyperliquidTestnetUserVenue,
  InMemoryNonceSource,
  PERP_COLLATERAL_ASSET,
  assertTestnetUrl,
  recoverTypedDataSigner,
  sendAssetAction,
  spotSendAction,
  splitSignature,
  typedDataDigest,
  usdClassTransferAction,
  usdSendAction,
  withdraw3Action,
  type FetchLike,
  type HlBook,
  type HlTypedData,
  type L1TypedData,
  type UserSignedTypedData,
} from '../src/index.js';
import { ceilTo, isHexKey, marketShape, probePriceFar, sizeForValue, validPriceAtOrBelow, type MarketShape } from './live-settings.js';
import { postExchange } from './testnet-setup.js';

const a = parseAmount;
/** Our TEST builder fee, as the simulator's journeys use it. */
export const BUILDER_FEE_BPS = a('0.5');
/** 10x, isolated: what J-derivatives-01 #5 signs. */
export const LEVERAGE_BPS = 100_000;
/** The venue's floor for a builder an account may approve (Hyperliquid docs, "Builder codes"). */
export const BUILDER_MIN_PERP_VALUE = a('100');
/** How far a marketable order's worst price sits from the touch: the SDK's own default slippage. */
const SLIPPAGE_UP = a('1.05');
const SLIPPAGE_DOWN = a('0.95');
/** J-derivatives-01's close: 40 percent first, pressed twice, then the rest. */
const PARTIAL_CLOSE = a('0.4');
const TEN_THOUSAND = a('10000');
/** A fee read from a fill is checked against the rate the venue publishes for this account to within this share. */
const FEE_TOLERANCE = a('0.05');
const DUST = a('0.00000001');
const CUSHION = a('2');
const TRANSFER_DECIMALS = 2;

type KeyName = 'trader' | 'agent' | 'other' | 'third';
/** The full run's keys; `--probe agent-funds` alone needs only the trader and the agent. */
const NEEDED_KEYS: readonly KeyName[] = ['trader', 'other', 'third', 'agent'];
const PROBE_KEYS: readonly KeyName[] = ['trader', 'agent'];

export const AGENT_PROBE = 'probe:agent-cannot-move-funds';
/** The pinned SDK commit the typed-data shapes follow (`src/fixtures/hl-python-sdk-signing-vectors.json`). */
const SDK_COMMIT = '2fdb18f9517675ea03695a0962bd19eece9c83f0';
/** The name the trader gives the probe's agent on the venue. */
const PROBE_AGENT_NAME = 'TEST probe agent';
/** What each agent-signed transfer tries to move: small, TEST funds. The withdrawal is larger than its fee. */
const PROBE_SEND = a('1');
const PROBE_WITHDRAW = a('2');

export interface LiveStepsDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv?: readonly string[];
  readonly fetch?: FetchLike;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export type LiveStepsExit = 0 | 1 | 2;

type Verdict = 'PASS' | 'FAIL' | 'SKIPPED';
interface Check {
  readonly name: string;
  readonly verdict: Verdict;
  readonly detail: string;
}
interface StepRecord {
  readonly journey: string;
  readonly n: number;
  readonly title: string;
  verdict: Verdict;
  readonly checks: Check[];
  readonly evidence: Record<string, unknown>;
  error?: string;
}

class Refused extends Error {}

/** A check that failed: the step is FAIL, and the rest of its group is skipped. */
class CheckFailed extends Error {}

const fmt = formatAmount;
const show = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? formatAmount(x) : x instanceof Date ? x.toISOString() : x));

function within(actual: Amount, expected: Amount): boolean {
  const room = add(mul(abs(expected), FEE_TOLERANCE, 'ceil'), DUST);
  return compare(abs(sub(actual, expected)), room) <= 0;
}

function bpsOf(basis: Amount, bps: Amount): Amount {
  return div(mul(basis, bps, 'half-up'), TEN_THOUSAND, 'half-up');
}

function bal(list: readonly UserVenueBalance[], asset: string): UserVenueBalance {
  return list.find((b) => b.asset === asset) ?? { asset, free: ZERO, locked: ZERO, total: ZERO };
}

function sum(values: readonly Amount[]): Amount {
  return values.reduce((t, v) => add(t, v), ZERO);
}

// ── keys: in memory only ────────────────────────────────────────────────────

interface Party {
  readonly name: KeyName;
  readonly account: UserVenueAccount;
  readonly signer: VenueSigner;
  readonly address: string;
  /** Signatures this party made in this run (the double-press checks count them). */
  signatures: number;
  sign(prepared: PreparedVenueAction): Promise<VenueSignature>;
  signDigest(digest: `0x${string}`): Promise<string>;
}

function readKeys(path: string | undefined, needed: readonly KeyName[]): Partial<Record<KeyName, `0x${string}`>> {
  if (!path) throw new Refused('HL_TESTNET_KEY_FILE is not set: give the path of the TESTNET key file the owner arranged.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Never echo the file's contents.
    throw new Refused('HL_TESTNET_KEY_FILE could not be read as JSON (its contents are not shown).');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Refused('HL_TESTNET_KEY_FILE must hold one JSON object (its contents are not shown).');
  const out: Partial<Record<KeyName, `0x${string}`>> = {};
  for (const name of needed) {
    const value = (parsed as Record<string, unknown>)[name];
    if (value === undefined) throw new Refused(`the key file has no "${name}" key; run testnet:setup first.`);
    if (!isHexKey(value)) throw new Refused(`key "${name}" is not a 32-byte hex key (its value is not shown).`);
    out[name] = value;
  }
  return out;
}

function party(name: KeyName, key: `0x${string}`): Party {
  const signerKey = privateKeyToAccount(key);
  const address = signerKey.address.toLowerCase();
  const p: Party = {
    name,
    address,
    account: { venueId: HL_TESTNET_VENUE_ID, owner: address, subAccount: null },
    signer: { role: 'owner', address },
    signatures: 0,
    async sign(prepared) {
      const typed = prepared.typedData as HlTypedData;
      const signature =
        typed.primaryType === 'Agent'
          ? await signerKey.signTypedData(typed as L1TypedData)
          : await signerKey.sign({ hash: typedDataDigest(typed) });
      p.signatures += 1;
      return { digest: prepared.digest, signature, signedBy: address };
    },
    async signDigest(digest) {
      p.signatures += 1;
      return signerKey.sign({ hash: digest });
    },
  };
  return p;
}

// ── the run ─────────────────────────────────────────────────────────────────

interface Placed {
  readonly who: Party;
  readonly symbol: string;
  readonly clientOrderKey: string;
  readonly cloid: string;
}

export async function runLiveSteps(deps: LiveStepsDeps): Promise<LiveStepsExit> {
  const { env, out, err } = deps;
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const argv = deps.argv ?? [];
  const outIndex = argv.indexOf('--out');
  const evidencePath = outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1]! : './live-steps-evidence.json';
  const probeIndex = argv.indexOf('--probe');
  const probeOnly = probeIndex >= 0;
  if (probeOnly && argv[probeIndex + 1] !== 'agent-funds') {
    err(`live steps refused: --probe takes "agent-funds", the one probe offered (got ${argv[probeIndex + 1] ?? 'nothing'}).`);
    return 2;
  }

  // ── refusals before anything is sent: mainnet, APP_ENV, the key file ──
  let baseUrl: string;
  let venue: HyperliquidTestnetUserVenue;
  let exchangeWrites = 0;
  const baseFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const fetchImpl: FetchLike = (input, init) => {
    if (input.endsWith('/exchange')) exchangeWrites += 1;
    return baseFetch(input, init);
  };
  const nonces = new InMemoryNonceSource();
  let keys: Partial<Record<KeyName, `0x${string}`>>;
  try {
    baseUrl = assertTestnetUrl(env.HL_API_URL ?? HL_TESTNET_API_URL);
    venue = new HyperliquidTestnetUserVenue({ appEnv: env.APP_ENV, baseUrl, fetch: fetchImpl, clock, nonceSource: nonces });
    keys = readKeys(env.HL_TESTNET_KEY_FILE, probeOnly ? PROBE_KEYS : NEEDED_KEYS);
  } catch (error) {
    err(`live steps refused: ${(error as Error).message}`);
    return 2;
  }
  const trader = party('trader', keys.trader!);
  const agent = party('agent', keys.agent!);
  // Not read for `--probe agent-funds` alone; no step uses them there.
  const other = keys.other ? party('other', keys.other) : trader;
  const builderParty = keys.third ? party('third', keys.third) : trader;

  const started = clock();
  const runId = started.toISOString().replace(/[-:.]/g, '').toLowerCase();
  const steps: StepRecord[] = [];
  const setupLog: string[] = [];
  const cleanupLog: string[] = [];
  const placed: Placed[] = [];
  const failedGroups = new Map<string, string>();
  let perpOpened = false;
  let leftOpen = false;
  /** Cleanup lines that report something kept on purpose (the probe's agent), not an order or position left open. */
  let notes = 0;
  let stopped: string | null = null;
  let settingsShown: Record<string, string> = {};

  const setup = (line: string) => {
    setupLog.push(line);
    out(`setup: ${line}`);
  };

  const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> => {
    let v = await read();
    for (let i = 0; i < 8 && !done(v); i += 1) {
      await sleep(500);
      v = await read();
    }
    return v;
  };

  const key = (step: string) => `live:${step}:${runId}`;
  const cloidOf = (k: string) => venueClientOrderId(HL_TESTNET_VENUE_ID, k);

  /** prepare, sign, submit. The prepared action and its signature are kept, as the door stores them, for a re-send. */
  const act = async (who: Party, intent: VenueIntent) => {
    const prepared = await venue.prepare(who.account, who.signer, intent);
    const signature = await who.sign(prepared);
    if (intent.kind === 'place_order')
      placed.push({ who, symbol: intent.symbol, clientOrderKey: intent.clientOrderKey, cloid: prepared.venueClientOrderId! });
    const outcome = await venue.submit(prepared, signature);
    return { prepared, signature, outcome };
  };

  /** An order's record after a submit: read back by its client id, whatever the answer was. */
  const orderOf = (who: Party, cloid: string) =>
    until(
      () => venue.orderByClientId(who.account, cloid),
      (r) => r.value !== null,
    );

  /** A user-signed transfer the `UserVenue` interface has no intent for (usdSend, usdClassTransfer). */
  const transfer = async (
    who: Party,
    label: string,
    build: (nonce: bigint) => { action: Record<string, unknown>; typedData: UserSignedTypedData },
  ) => {
    const nonce = await nonces.next(who.address, clock().getTime());
    const { action, typedData } = build(BigInt(nonce));
    const signature = await who.signDigest(typedDataDigest(typedData));
    if ((await recoverTypedDataSigner(typedData, signature)) !== who.address)
      throw new Error(`${label}: the signature does not recover ${who.name}`);
    const verdict = await postExchange(
      fetchImpl,
      baseUrl,
      JSON.stringify({ action, nonce: Number(nonce), signature: splitSignature(signature), vaultAddress: null, expiresAfter: null }),
    );
    setup(`${label} (nonce ${nonce}): ${verdict.text}`);
    if (!verdict.ok) throw new Error(`${label}: ${verdict.text}`);
  };
  const toDecimals = (v: Amount) => fmt(ceilTo(v, TRANSFER_DECIMALS));

  const balancesOf = async (who: Party) => (await venue.balances(who.account)).value;

  /** Move spot USDC to perp (toPerp) or back, for `who`, and wait until the venue shows it. */
  const classTransfer = async (who: Party, amount: Amount, toPerp: boolean) => {
    const asset = toPerp ? PERP_COLLATERAL_ASSET : 'USDC';
    const before = bal(await balancesOf(who), asset).free;
    const amt = toDecimals(amount);
    await transfer(who, `usdClassTransfer ${amt} USDC ${toPerp ? 'spot -> perp' : 'perp -> spot'} for ${who.name}`, (n) =>
      usdClassTransferAction(amt, toPerp, n),
    );
    await until(
      () => balancesOf(who),
      (b) => compare(bal(b, asset).free, before) > 0,
    );
  };

  const usdSend = async (to: Party, amount: Amount) => {
    const before = bal(await balancesOf(to), PERP_COLLATERAL_ASSET).total;
    const amt = toDecimals(amount);
    await transfer(trader, `usdSend ${amt} USDC trader -> ${to.name}`, (n) => usdSendAction(to.address, amt, n));
    await until(
      () => balancesOf(to),
      (b) => compare(bal(b, PERP_COLLATERAL_ASSET).total, before) > 0,
    );
  };

  /** Close the perp position this run opened (reduce-only IOC at the touch's worst price), and say what is left. */
  const closePerp = async () => {
    const symbol = settingsShown.perpSymbol!;
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const pos = (await venue.positions(trader.account)).value.find((x) => x.symbol === symbol);
        if (!pos) break;
        const shape = await marketShape(venue, symbol);
        const book = (await venue.l2Book(symbol)).value;
        const touch = pos.side === 'long' ? book.bids[0]?.price : book.asks[0]?.price;
        if (touch === undefined) throw new Error(`${symbol}'s book has no ${pos.side === 'long' ? 'bids' : 'asks'} to close into`);
        const c = await act(trader, {
          kind: 'place_order',
          symbol,
          side: pos.side === 'long' ? 'sell' : 'buy',
          type: 'market',
          amount: pos.size,
          price: pos.side === 'long' ? worstBelow(touch, shape) : worstAbove(touch, shape),
          timeInForce: 'IOC',
          reduceOnly: true,
          clientOrderKey: key(`cleanup-close-${attempt}`),
          builderFee: null,
        });
        const line = `closed ${pos.side} ${fmt(pos.size)} ${symbol} (reduce-only IOC): ${outcomeText(c.outcome)}`;
        cleanupLog.push(line);
        out(`cleanup: ${line}`);
        await until(
          () => venue.positions(trader.account),
          (r) => !r.value.some((x) => x.symbol === symbol),
        );
      }
      const left = (await venue.positions(trader.account)).value.find((x) => x.symbol === symbol);
      if (!left) perpOpened = false;
      else {
        leftOpen = true;
        const line = `LEFT OPEN: ${left.side} ${fmt(left.size)} ${symbol}; close it by hand on the testnet`;
        cleanupLog.push(line);
        out(`cleanup: ${line}`);
      }
    } catch (error) {
      leftOpen = true;
      const line = `could not close the ${symbol} position: ${(error as Error).message}; close it by hand on the testnet`;
      cleanupLog.push(line);
      out(`cleanup: ${line}`);
    }
  };

  const step = async (journey: string, n: number, title: string, group: string, body: (s: StepContext) => Promise<void>) => {
    const record: StepRecord = { journey, n, title, verdict: 'SKIPPED', checks: [], evidence: {} };
    steps.push(record);
    const ctx = new StepContext(record);
    const blocked = stopped ?? failedGroups.get(group);
    if (blocked) {
      ctx.skip('step', blocked);
    } else {
      try {
        await body(ctx);
      } catch (error) {
        if (!(error instanceof CheckFailed)) {
          record.error = (error as Error).message;
          record.checks.push({ name: 'ran', verdict: 'FAIL', detail: record.error });
        }
      }
    }
    record.verdict = record.checks.some((c) => c.verdict === 'FAIL')
      ? 'FAIL'
      : record.checks.some((c) => c.verdict === 'PASS')
        ? 'PASS'
        : 'SKIPPED';
    if (record.verdict === 'FAIL' && !failedGroups.has(group)) failedGroups.set(group, `${journey} #${n} failed first`);
    out(lineOf(record));
  };

  // ── probe:agent-cannot-move-funds ──
  /** The venue's spot token name for USDC, `USDC:<tokenId>`, from its own spotMeta; `null` when it lists no tokenId. */
  const usdcSpotToken = async (): Promise<string | null> => {
    const res = await fetchImpl(`${baseUrl}/info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'spotMeta' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`spotMeta: HTTP ${res.status}`);
    const meta = JSON.parse(await res.text()) as { tokens?: { name?: unknown; tokenId?: unknown }[] };
    const usdc = (meta.tokens ?? []).find((t) => t.name === 'USDC');
    return usdc && typeof usdc.tokenId === 'string' && /^0x[0-9a-fA-F]{32}$/.test(usdc.tokenId) ? `USDC:${usdc.tokenId}` : null;
  };

  const agentProbe = () =>
    step(
      AGENT_PROBE,
      0,
      "an agent key cannot move the trader's funds: agent-signed withdraw3, usdSend, spotSend and sendAsset are each refused by the venue, and the trader's balances do not move",
      'agent-probe',
      async (s) => {
        // 1. The trader approves the agent (owner signed, through the adapter), unless the venue already lists it.
        const listed = async () =>
          (await venue.agents(trader.account)).value.some(
            (x) => x.address === agent.address && (x.validUntil === null || x.validUntil.getTime() > clock().getTime()),
          );
        const wasApproved = await listed();
        s.ev('agent', { address: agent.address, approvedBefore: wasApproved });
        let approvedHere = false;
        if (wasApproved) s.pass('agent approved', `the venue already lists ${agent.address} for the trader; not approved again`);
        else {
          const { outcome } = await act(trader, {
            kind: 'approve_agent',
            agentAddress: agent.address,
            agentName: PROBE_AGENT_NAME,
            validUntil: null,
          });
          s.ev('approveAgentOutcome', outcome);
          const now = await until(listed, (v) => v);
          // Whatever the answer said, an agent the venue now lists was approved by this run.
          approvedHere = now;
          s.check('agent approved', now, `approveAgent signed by the trader: ${outcomeText(outcome)}; the venue lists the agent: ${now}`);
        }
        try {
          // 2. The trader's (and the agent's) balances before anything is sent.
          const traderBefore = await balancesOf(trader);
          const agentBefore = (await venue.balances(agent.account)).value;
          s.ev('traderBalancesBefore', traderBefore);
          s.ev('agentBalancesBefore', agentBefore);
          const token = await usdcSpotToken();

          interface Sent {
            readonly action: string;
            readonly typedData: string;
            readonly signedBy: string;
            readonly destination: string;
            readonly amount: string;
            readonly answer: 'refused' | 'ACCEPTED' | 'no definite answer' | 'not sent';
            readonly venueWords: string | null;
            readonly httpStatus: number | null;
            readonly suggests: string;
          }
          const sent: Sent[] = [];
          const send = async (
            label: string,
            primaryType: string,
            amount: Amount,
            build: (nonce: bigint) => { action: Record<string, unknown>; typedData: UserSignedTypedData },
          ) => {
            const nonce = BigInt(await nonces.next(agent.address, clock().getTime()));
            const { action, typedData } = build(nonce);
            if (typedData.primaryType !== primaryType) throw new Error(`${label}: built ${typedData.primaryType}, not ${primaryType}`);
            const signature = await agent.signDigest(typedDataDigest(typedData));
            if ((await recoverTypedDataSigner(typedData, signature)) !== agent.address)
              throw new Error(`${label}: the signature does not recover the agent`);
            const verdict = await postExchange(
              fetchImpl,
              baseUrl,
              JSON.stringify({
                action,
                nonce: Number(nonce),
                signature: splitSignature(signature),
                vaultAddress: null,
                expiresAfter: null,
              }),
            );
            const refused =
              !verdict.ok &&
              (verdict.text.startsWith('refused by the venue') ||
                (verdict.httpStatus !== null && verdict.httpStatus >= 400 && verdict.httpStatus < 500));
            const words = verdict.raw ?? verdict.text;
            const record: Sent = {
              action: label,
              typedData: primaryType,
              signedBy: agent.address,
              destination: agent.address,
              amount: fmt(amount),
              answer: verdict.ok ? 'ACCEPTED' : refused ? 'refused' : 'no definite answer',
              venueWords: words,
              httpStatus: verdict.httpStatus,
              suggests: verdict.ok ? '-' : refused ? suggestsFrom(words ?? '') : '-',
            };
            sent.push(record);
            if (verdict.ok) err(`PROBE FAIL ${AGENT_PROBE}: the venue ACCEPTED an agent-signed ${label}: ${words ?? 'ok'}`);
          };

          // 3. Each action, signed by the agent key, moving the TRADER's funds to the agent's own address.
          await send('withdraw3', 'HyperliquidTransaction:Withdraw', PROBE_WITHDRAW, (n) =>
            withdraw3Action(agent.address, fmt(PROBE_WITHDRAW), n),
          );
          await send('usdSend', 'HyperliquidTransaction:UsdSend', PROBE_SEND, (n) => usdSendAction(agent.address, fmt(PROBE_SEND), n));
          if (token === null) {
            sent.push({
              action: 'spotSend',
              typedData: 'HyperliquidTransaction:SpotSend',
              signedBy: agent.address,
              destination: agent.address,
              amount: fmt(PROBE_SEND),
              answer: 'not sent',
              venueWords: null,
              httpStatus: null,
              suggests: '-',
            });
          } else
            await send('spotSend', 'HyperliquidTransaction:SpotSend', PROBE_SEND, (n) =>
              spotSendAction(agent.address, token, fmt(PROBE_SEND), n),
            );
          await send('sendAsset', 'HyperliquidTransaction:SendAsset', PROBE_SEND, (n) =>
            sendAssetAction(
              { destination: agent.address, sourceDex: '', destinationDex: '', token: 'USDC', amount: fmt(PROBE_SEND), fromSubAccount: '' },
              n,
            ),
          );
          s.ev('sent', sent);

          // 4. The trader's balances after: unchanged (the probe signs nothing of the trader's that carries a fee).
          const traderAfter = await until(
            () => balancesOf(trader),
            (b) => show(b) !== show(traderBefore),
          );
          const agentAfter = (await venue.balances(agent.account)).value;
          s.ev('traderBalancesAfter', traderAfter);
          s.ev('agentBalancesAfter', agentAfter);

          for (const x of sent) {
            if (x.answer === 'refused')
              s.assess(`${x.action} refused`, true, `the venue: ${x.venueWords ?? '(no body)'}; wording suggests: ${x.suggests}`);
            else if (x.answer === 'not sent')
              s.skip(`${x.action} refused`, "not sent: the venue's spotMeta lists no tokenId for USDC, so the token is not guessed");
            else if (x.answer === 'ACCEPTED')
              s.assess(`${x.action} refused`, false, `ACCEPTED by the venue from the agent key: ${x.venueWords ?? 'ok'}`);
            else s.assess(`${x.action} refused`, false, `no definite answer from the venue: ${x.venueWords ?? '(nothing readable)'}`);
          }
          s.skip(
            'agentSendAsset refused to any address but its own source',
            `not in the pinned SDK (hyperliquid-python-sdk ${SDK_COMMIT.slice(0, 12)}): its shape is not guessed`,
          );
          const moved = balanceChanges(traderBefore, traderAfter);
          s.assess(
            "trader's balances unchanged",
            moved.length === 0,
            moved.length === 0 ? 'spot and perp, every asset, as before' : `MOVED: ${moved.join('; ')}`,
          );
          const gained = balanceChanges(agentBefore, agentAfter).filter((c) => c.includes('(+'));
          s.assess("nothing reached the agent's address", gained.length === 0, gained.length === 0 ? 'no balance rose' : gained.join('; '));
          const accepted = sent.filter((x) => x.answer === 'ACCEPTED').map((x) => x.action);
          const tally = sent
            .filter((x) => x.answer === 'refused')
            .map((x) => `${x.action}: ${x.suggests}`)
            .join(', ');
          s.summary(
            accepted.length > 0
              ? `ACCEPTED from the agent key: ${accepted.join(', ')}`
              : `every action sent was refused; trader's balances ${moved.length === 0 ? 'unchanged' : 'MOVED'}; wording suggests ${tally || 'nothing'}`,
          );
        } finally {
          // 5. Leave the agent as it was found. The pinned SDK has no revoke form, so one approved here stays approved.
          if (approvedHere) {
            const line = `agent ${agent.address} stays approved on the trader's account ("${PROBE_AGENT_NAME}"): the pinned SDK (${SDK_COMMIT.slice(0, 12)}) has no form to revoke an agent, so this run cannot revoke it; remove it by hand on the testnet if it must go`;
            cleanupLog.push(line);
            notes += 1;
            out(`cleanup: ${line}`);
            s.ev('agentLeftApproved', true);
          }
        }
      },
    );

  let exit: LiveStepsExit = 0;
  if (probeOnly) {
    out(`venue: ${venue.venue.displayName} (${venue.venue.id}, ${baseUrl}), TEST funds only; run ${runId}; ${AGENT_PROBE} alone`);
    out(`addresses: trader ${trader.address}, agent ${agent.address}`);
    try {
      await agentProbe();
    } catch (error) {
      stopped = `the run stopped: ${(error as Error).message}`;
      err(`live steps stopped: ${(error as Error).message}`);
      exit = 1;
    }
    if (cleanupLog.length === notes) out('cleanup: nothing left open by this run');
    return finish(exit);
  }
  try {
    out(`venue: ${venue.venue.displayName} (${venue.venue.id}, ${baseUrl}), TEST funds only; run ${runId}`);
    out(`addresses: trader ${trader.address}, agent ${agent.address}, other ${other.address}, builder (third) ${builderParty.address}`);

    // ── settings, read-only ──
    const markets = (await venue.markets(trader.account)).value;
    const spotSymbol = env.HL_SPOT_SYMBOL || (await pickSpot(venue, markets));
    const spotMarket = markets.find((m) => m.symbol === spotSymbol);
    if (!spotMarket || spotMarket.kind !== 'spot') throw new Refused(`${spotSymbol} is not a spot market on the testnet`);
    const spotShape = await marketShape(venue, spotSymbol);
    const spotBook = (await venue.l2Book(spotSymbol)).value;
    const restPrice = env.HL_SPOT_PRICE ? a(env.HL_SPOT_PRICE) : insidePrice(spotBook, spotShape);
    if (restPrice === null) throw new Refused(`${spotSymbol}'s book leaves no valid price strictly inside its spread; set HL_SPOT_PRICE`);
    const bestAsk = spotBook.asks[0]?.price;
    if (bestAsk === undefined) throw new Refused(`${spotSymbol} has no asks: #9's market buy has nothing to meet`);
    if (compare(restPrice, bestAsk) >= 0)
      throw new Refused(`HL_SPOT_PRICE ${fmt(restPrice)} is not below the best ask ${fmt(bestAsk)}: it would not rest`);
    const restSize = sizeForValue(restPrice, spotShape.szDecimals);
    const marketWorst = worstAbove(bestAsk, spotShape);
    const marketSize = sizeForValue(bestAsk, spotShape.szDecimals);
    const awayPrice = probePriceFar(spotBook, spotShape);
    if (awayPrice === null) throw new Refused(`${spotSymbol}'s book is empty`);
    const awaySize = sizeForValue(awayPrice, spotShape.szDecimals);

    const perpSymbol = env.HL_PERP_SYMBOL || 'ETH-PERP';
    const perpMarket = markets.find((m) => m.symbol === perpSymbol);
    if (!perpMarket || perpMarket.kind !== 'perpetual') throw new Refused(`${perpSymbol} is not a perpetual on the testnet`);
    const perpShape = await marketShape(venue, perpSymbol);
    const perpBook = (await venue.l2Book(perpSymbol)).value;
    const perpAsk = perpBook.asks[0]?.price;
    const perpBid = perpBook.bids[0]?.price;
    if (perpAsk === undefined || perpBid === undefined) throw new Refused(`${perpSymbol}'s book is one-sided or empty`);
    const closePart = sizeForValue(perpBid, perpShape.szDecimals);
    const openSize = ceilTo(div(closePart, PARTIAL_CLOSE, 'ceil'), perpShape.szDecimals);
    const openWorst = worstAbove(perpAsk, perpShape);
    const withdrawAmount = a(env.HL_WITHDRAW_AMOUNT || '2');

    settingsShown = {
      spotSymbol,
      restPrice: fmt(restPrice),
      restSize: fmt(restSize),
      marketWorst: fmt(marketWorst),
      marketSize: fmt(marketSize),
      awayPrice: fmt(awayPrice),
      awaySize: fmt(awaySize),
      perpSymbol,
      openSize: fmt(openSize),
      closePart: fmt(closePart),
      openWorst: fmt(openWorst),
      withdrawAmount: fmt(withdrawAmount),
      builder: builderParty.address,
      builderFeeBps: fmt(BUILDER_FEE_BPS),
    };
    out(
      `settings: ${Object.entries(settingsShown)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );

    // ── preflight: what the run spends, against what the trader holds (changes only from here on) ──
    const startBalances = await balancesOf(trader);
    const spotNeed = add(
      add(add(mul(restPrice, restSize, 'ceil'), mul(marketWorst, marketSize, 'ceil')), mul(awayPrice, awaySize, 'ceil')),
      CUSHION,
    );
    const approvalAtStart = (await venue.builderFeeApproval(trader.account, builderParty.address)).value;
    const builderTopUp = compare(approvalAtStart, BUILDER_FEE_BPS) >= 0 ? ZERO : BUILDER_MIN_PERP_VALUE;
    // The open's margin at 10x, the withdrawal, the builder's top-up when the approval is still to sign, and a cushion
    // for fees and "other"'s funding.
    const perpNeed = add(
      add(div(mul(openWorst, openSize, 'ceil'), a('10'), 'ceil'), withdrawAmount),
      add(builderTopUp, add(CUSHION, mul(restPrice, restSize, 'ceil'))),
    );
    const spotFree = bal(startBalances, 'USDC').free;
    const perpFree = bal(startBalances, PERP_COLLATERAL_ASSET).free;
    if (compare(add(spotFree, perpFree), add(spotNeed, perpNeed)) < 0) {
      throw new Refused(
        `trader holds ${fmt(spotFree)} spot and ${fmt(perpFree)} perp USDC free; the run needs about ${fmt(spotNeed)} spot and ${fmt(perpNeed)} perp. Top it up from the testnet faucet.`,
      );
    }
    const startPositions = (await venue.positions(trader.account)).value;
    const perpBusy = startPositions.find((p) => p.symbol === perpSymbol);
    if (perpBusy)
      failedGroups.set(
        'perp',
        `the trader already holds a ${perpSymbol} position (${fmt(perpBusy.size)}); this run leaves positions it did not open alone`,
      );
    if (compare(spotFree, spotNeed) < 0) await classTransfer(trader, sub(spotNeed, spotFree), false);

    // ── the builder-fee approval, shared by both journeys ──
    const ensureApproval = async (s: StepContext, probe: PlaceUserOrderIntent) => {
      const approval = await venue.builderFeeApproval(trader.account, builderParty.address);
      s.ev('builderApprovalBefore', { bps: approval.value, asOf: approval.asOf });
      if (compare(approval.value, BUILDER_FEE_BPS) >= 0) {
        s.pass('builder-fee approval', `already approved on the venue: ${fmt(approval.value)} bps (as of ${approval.asOf.toISOString()})`);
        return;
      }
      // Below the fee: the order is refused before anything is signed.
      const signedBefore = trader.signatures;
      try {
        await venue.prepare(trader.account, trader.signer, probe);
        s.fail('order refused before the approval', 'prepare accepted an order whose builder fee the account has not approved');
      } catch (error) {
        const code = error instanceof VenueRefusalError ? error.refusal.code : 'thrown';
        s.check(
          'order refused before the approval',
          code === 'builder_fee_not_approved' && trader.signatures === signedBefore,
          `refused ${code}, nothing signed`,
        );
      }
      const builderValue = bal(await balancesOf(builderParty), PERP_COLLATERAL_ASSET).total;
      if (compare(builderValue, BUILDER_MIN_PERP_VALUE) < 0)
        await usdSend(builderParty, add(sub(BUILDER_MIN_PERP_VALUE, builderValue), a('1')));
      const { outcome } = await act(trader, { kind: 'approve_builder_fee', builder: builderParty.address, maxFeeBps: BUILDER_FEE_BPS });
      s.ev('approvalOutcome', outcome);
      const after = await until(
        () => venue.builderFeeApproval(trader.account, builderParty.address),
        (r) => compare(r.value, BUILDER_FEE_BPS) >= 0,
      );
      s.ev('builderApprovalAfter', { bps: after.value, asOf: after.asOf });
      s.check(
        'builder-fee approval',
        compare(after.value, BUILDER_FEE_BPS) >= 0,
        `signed once by the owner; the venue records ${fmt(after.value)} bps (as of ${after.asOf.toISOString()})`,
      );
    };

    // ════════ J-cex-spot-01 ════════
    const J1 = 'J-cex-spot-01';
    const buyIntent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: spotSymbol,
      side: 'buy',
      type: 'limit',
      amount: restSize,
      price: restPrice,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: key('spot-7'),
      builderFee: { builder: builderParty.address, feeBps: BUILDER_FEE_BPS },
    };
    let stored: { prepared: PreparedVenueAction; signature: VenueSignature } | null = null;
    let restPreview: Preview | null = null;
    let afterRest: readonly UserVenueBalance[] | null = null;

    // #6: the review's figures, from the venue (no order sent): what the venue locks, its fee and our builder fee at
    // the rates it publishes for this account, the maker role (the price rests below the best ask), GTC, the client id
    // held for retry (two prepares of one intent name one venue client id), and the builder-fee approval.
    await step(
      J1,
      6,
      'reviews a limit buy: the venue lock, fees, maker role, time in force, the client id held for retry, the builder-fee approval',
      'spot-trade',
      async (s) => {
        const writes = exchangeWrites;
        const p = await preview(venue, trader.account, buyIntent, spotMarket, spotBook);
        restPreview = p;
        s.ev('preview', p);
        s.check(
          'lock',
          p.lock.asset === spotMarket.quoteAsset && p.lock.amount === mul(restPrice, restSize, 'ceil'),
          `${fmt(p.lock.amount)} ${p.lock.asset} (price x size)`,
        );
        s.check(
          'fee rates published',
          p.venueFee.known && p.builderFee.known,
          p.venueFee.known
            ? `venue fee ${fmt(p.venueFee.amount)} ${p.venueFee.asset}, builder fee ${fmt(p.builderFee.amount)} ${p.builderFee.asset}`
            : 'the venue publishes no fee rate for this account',
        );
        s.check('role', p.role === 'maker', `${p.role} (price ${fmt(restPrice)} below the best ask ${fmt(bestAsk)})`);
        s.check('time in force', buyIntent.timeInForce === 'GTC', 'GTC');
        await ensureApproval(s, buyIntent);
        const first = await venue.prepare(trader.account, trader.signer, buyIntent);
        const second = await venue.prepare(trader.account, trader.signer, buyIntent);
        s.check(
          'client id held for retry',
          first.venueClientOrderId === second.venueClientOrderId &&
            first.nonce !== second.nonce &&
            first.venueClientOrderId === cloidOf(buyIntent.clientOrderKey),
          `cloid ${first.venueClientOrderId} for key ${buyIntent.clientOrderKey}, the same on a second prepare`,
        );
        stored = { prepared: first, signature: await trader.sign(first) };
        const none = await venue.orderByClientId(trader.account, first.venueClientOrderId!);
        s.check(
          'nothing placed',
          none.value === null,
          `no order with that cloid on the venue (as of ${none.asOf.toISOString()}); ${exchangeWrites - writes} exchange write(s), the approval's only`,
        );
        s.summary(
          `lock ${fmt(p.lock.amount)} ${p.lock.asset}, venue fee ${fmt(p.venueFee.amount)} ${p.venueFee.asset}, builder fee ${fmt(p.builderFee.amount)} ${p.builderFee.asset}, maker, GTC, cloid ${first.venueClientOrderId}`,
        );
      },
    );

    // #7: the signed order rests on the venue: open, its lock the venue's (the trader's quote hold rises by it), and a
    // re-send of the same signed bytes (a double press) is not a second order.
    await step(
      J1,
      7,
      "confirms and signs: the order rests on the venue and shows Open; the locked amount equals the venue's",
      'spot-trade',
      async (s) => {
        if (!stored || !restPreview) throw new Error('#6 kept no signed action');
        const { prepared, signature } = stored as { prepared: PreparedVenueAction; signature: VenueSignature };
        const before = await balancesOf(trader);
        placed.push({ who: trader, symbol: spotSymbol, clientOrderKey: buyIntent.clientOrderKey, cloid: prepared.venueClientOrderId! });
        const signed = trader.signatures;
        const outcome = await venue.submit(prepared, signature);
        s.ev('outcome', outcome);
        const resent = await venue.submit(prepared, signature);
        s.ev('resent', resent);
        const order = (await orderOf(trader, prepared.venueClientOrderId!)).value;
        s.ev('order', order);
        s.check('open on the venue', order?.status === 'open', `status ${order?.status ?? 'none'}, oid ${order?.venueOrderId ?? '-'}`);
        s.check('time in force', order?.timeInForce === 'GTC', `${order?.timeInForce ?? '-'}`);
        const sameCloid = (await venue.openOrders(trader.account)).value.filter(
          (o) => o.venueClientOrderId === prepared.venueClientOrderId,
        );
        s.check(
          'one order for the cloid (double press)',
          sameCloid.length === 1 && trader.signatures === signed,
          `${sameCloid.length} open order(s); re-send answered ${outcomeText(resent)}; no new signature`,
        );
        s.check(
          "lock equals the venue's",
          order !== null && order.locked === (restPreview as Preview).lock.amount,
          `order locks ${order ? fmt(order.locked) : '-'} ${order?.lockedAsset ?? ''}`,
        );
        afterRest = await until(
          () => balancesOf(trader),
          (b) => sub(bal(b, spotMarket.quoteAsset).locked, bal(before, spotMarket.quoteAsset).locked) === (order?.locked ?? ZERO),
        );
        const held = sub(bal(afterRest, spotMarket.quoteAsset).locked, bal(before, spotMarket.quoteAsset).locked);
        s.check('balance hold moved by the lock', held === order?.locked, `${spotMarket.quoteAsset} hold +${fmt(held)}`);
        s.summary(`oid ${order?.venueOrderId}, cloid ${prepared.venueClientOrderId}, open, locks ${fmt(held)} ${spotMarket.quoteAsset}`);
      },
    );

    // #8: a sell from "other" fills the resting buy: filled at its own price and size as maker, the venue's fee at the
    // maker rate, our builder fee, and the trader's balances move by exactly the fill.
    await step(
      J1,
      8,
      "a sell on the venue fills the order: price, size, the venue's fee, our builder fee and the maker role; the balances move by the fill",
      'spot-trade',
      async (s) => {
        if (!stored || !restPreview || !afterRest) throw new Error('#7 left no resting order');
        const cloid = (stored as { prepared: PreparedVenueAction }).prepared.venueClientOrderId!;
        const p = restPreview as Preview;
        const base = spotMarket.baseAsset;
        const quote = spotMarket.quoteAsset;
        // "other" needs restSize of the base to sell.
        let otherBalances = await balancesOf(other);
        if (compare(bal(otherBalances, base).free, restSize) < 0) {
          const lot = ceilTo(DUST, spotShape.szDecimals);
          const buySize = max(ceilTo(mul(restSize, a('1.01'), 'ceil'), spotShape.szDecimals), add(restSize, lot));
          const cost = add(mul(buySize, marketWorst, 'ceil'), a('1'));
          const otherSpot = bal(otherBalances, 'USDC').free;
          if (compare(otherSpot, cost) < 0) {
            const send = add(sub(cost, otherSpot), a('1'));
            await usdSend(other, send);
            await classTransfer(other, send, false);
          }
          const bought = await act(other, {
            kind: 'place_order',
            symbol: spotSymbol,
            side: 'buy',
            type: 'limit',
            amount: buySize,
            price: marketWorst,
            timeInForce: 'IOC',
            reduceOnly: false,
            clientOrderKey: key('spot-8-other-buy'),
            builderFee: null,
          });
          setup(
            `other bought ${fmt(buySize)} ${base} from the live book (IOC at most ${fmt(marketWorst)}): ${outcomeText(bought.outcome)}`,
          );
          otherBalances = await until(
            () => balancesOf(other),
            (b) => compare(bal(b, base).free, restSize) >= 0,
          );
          if (compare(bal(otherBalances, base).free, restSize) < 0)
            throw new Error(`other holds ${fmt(bal(otherBalances, base).free)} ${base}, less than ${fmt(restSize)}`);
        }
        const sold = await act(other, {
          kind: 'place_order',
          symbol: spotSymbol,
          side: 'sell',
          type: 'limit',
          amount: restSize,
          price: restPrice,
          timeInForce: 'IOC',
          reduceOnly: false,
          clientOrderKey: key('spot-8-other-sell'),
          builderFee: null,
        });
        s.ev('otherSell', sold.outcome);
        const order = (
          await until(
            () => venue.orderByClientId(trader.account, cloid),
            (r) => r.value?.status === 'filled',
          )
        ).value;
        s.ev('order', order);
        s.check('filled', order?.status === 'filled', `status ${order?.status ?? 'none'}`);
        const fills = (
          await until(
            () => venue.fills(trader.account, started),
            (r) => sum(r.value.filter((f) => f.venueClientOrderId === cloid).map((f) => f.amount)) === restSize,
          )
        ).value.filter((f) => f.venueClientOrderId === cloid);
        s.ev('fills', fills);
        const filled = sum(fills.map((f) => f.amount));
        s.check(
          'size',
          filled === restSize,
          `${fmt(filled)} of ${fmt(restSize)} in ${fills.length} fill(s): ${fills.map((f) => `tid ${f.fillId}`).join(', ')}`,
        );
        s.check('price', fills.length > 0 && fills.every((f) => f.price === restPrice), `${fills.map((f) => fmt(f.price)).join(', ')}`);
        s.check('maker role', fills.length > 0 && fills.every((f) => f.role === 'maker'), `${fills.map((f) => f.role).join(', ')}`);
        const venueFee = sum(fills.map((f) => f.venueFee));
        const builderFee = sum(fills.map((f) => f.builderFee));
        const feeAsset = fills[0]?.feeAsset ?? '-';
        s.check(
          'venue fee at the published maker rate',
          p.venueFee.known && feeAsset === p.venueFee.asset && within(venueFee, p.venueFee.amount),
          `${fmt(venueFee)} ${feeAsset}; the review said ${fmt(p.venueFee.amount)} ${p.venueFee.asset}`,
        );
        s.check(
          'our builder fee',
          compare(builderFee, ZERO) > 0 && within(builderFee, p.builderFee.amount),
          `${fmt(builderFee)} ${feeAsset}; the review said ${fmt(p.builderFee.amount)} ${p.builderFee.asset}`,
        );
        const after = await until(
          () => balancesOf(trader),
          (b) => bal(b, base).total !== bal(afterRest!, base).total,
        );
        const totalFee = add(venueFee, builderFee);
        const notional = sum(fills.map((f) => mul(f.price, f.amount, 'half-up')));
        const expectQuote = sub(ZERO, add(notional, feeAsset === quote ? totalFee : ZERO));
        const expectBase = sub(filled, feeAsset === base ? totalFee : ZERO);
        const dQuote = sub(bal(after, quote).total, bal(afterRest, quote).total);
        const dBase = sub(bal(after, base).total, bal(afterRest, base).total);
        const dHold = sub(bal(after, quote).locked, bal(afterRest, quote).locked);
        s.check(
          'balances moved by the fill',
          within(dQuote, expectQuote) && within(dBase, expectBase) && dHold === sub(ZERO, p.lock.amount),
          `${quote} ${fmt(dQuote)} (hold ${fmt(dHold)}), ${base} +${fmt(dBase)}`,
        );
        s.summary(
          `filled by other's IOC sell; tid ${fills.map((f) => f.fillId).join(',')}, ${fmt(filled)} at ${fmt(restPrice)}, maker, venue fee ${fmt(venueFee)} ${feeAsset}, builder fee ${fmt(builderFee)} ${feeAsset}`,
        );
      },
    );

    // #9: a market buy (an IOC at its worst price) fills on the venue inside its limit; nothing stays locked.
    await step(
      J1,
      9,
      'places a market buy: it fills on the venue inside its slippage limit; nothing stays locked',
      'spot-market',
      async (s) => {
        const before = await balancesOf(trader);
        const k = key('spot-9');
        const { outcome } = await act(trader, {
          kind: 'place_order',
          symbol: spotSymbol,
          side: 'buy',
          type: 'market',
          amount: marketSize,
          price: marketWorst,
          timeInForce: 'IOC',
          reduceOnly: false,
          clientOrderKey: k,
          builderFee: { builder: builderParty.address, feeBps: BUILDER_FEE_BPS },
        });
        s.ev('outcome', outcome);
        const cloid = cloidOf(k);
        const order = (
          await until(
            () => venue.orderByClientId(trader.account, cloid),
            (r) => r.value !== null && r.value.status !== 'open',
          )
        ).value;
        s.ev('order', order);
        const fills = (
          await until(
            () => venue.fills(trader.account, started),
            (r) => r.value.some((f) => f.venueClientOrderId === cloid),
          )
        ).value.filter((f) => f.venueClientOrderId === cloid);
        s.ev('fills', fills);
        const filled = sum(fills.map((f) => f.amount));
        s.check(
          'filled',
          fills.length > 0 && compare(filled, ZERO) > 0,
          `${fmt(filled)} of ${fmt(marketSize)} (order ${order?.status ?? 'none'}), tid ${fills.map((f) => f.fillId).join(',')}`,
        );
        s.check(
          'inside the slippage limit',
          fills.every((f) => compare(f.price, marketWorst) <= 0),
          `prices ${fills.map((f) => fmt(f.price)).join(', ')} at most ${fmt(marketWorst)}`,
        );
        s.check('taker role', fills.length > 0 && fills.every((f) => f.role === 'taker'), fills.map((f) => f.role).join(', '));
        const after = await balancesOf(trader);
        const dHold = sub(bal(after, spotMarket.quoteAsset).locked, bal(before, spotMarket.quoteAsset).locked);
        const open = (await venue.openOrders(trader.account)).value.filter((o) => o.venueClientOrderId === cloid);
        s.check(
          'nothing stays locked',
          dHold === ZERO && open.length === 0,
          `${spotMarket.quoteAsset} hold change ${fmt(dHold)}; ${open.length} open order(s) for the cloid`,
        );
        s.summary(
          `cloid ${cloid}, ${fmt(filled)} filled at ${fills.map((f) => fmt(f.price)).join(',')} (limit ${fmt(marketWorst)}), taker, fees ${fmt(sum(fills.map((f) => f.venueFee)))} + builder ${fmt(sum(fills.map((f) => f.builderFee)))}`,
        );
      },
    );

    // #10: a limit far from the market rests, is cancelled (the lock released), and the repeat cancel (the same signed
    // bytes, no new signature) reports the same outcome.
    await step(
      J1,
      10,
      'rests a limit away from the market, cancels it, cancels it again: cancelled, the lock released; the repeat reports the same outcome',
      'spot-cancel',
      async (s) => {
        const before = await balancesOf(trader);
        const k = key('spot-10');
        const { outcome } = await act(trader, {
          kind: 'place_order',
          symbol: spotSymbol,
          side: 'buy',
          type: 'limit',
          amount: awaySize,
          price: awayPrice,
          timeInForce: 'GTC',
          reduceOnly: false,
          clientOrderKey: k,
          builderFee: null,
        });
        s.ev('placeOutcome', outcome);
        const cloid = cloidOf(k);
        const resting = (await orderOf(trader, cloid)).value;
        s.check('rests open', resting?.status === 'open', `status ${resting?.status ?? 'none'}, oid ${resting?.venueOrderId ?? '-'}`);
        const rested = await until(
          () => balancesOf(trader),
          (b) => bal(b, spotMarket.quoteAsset).locked !== bal(before, spotMarket.quoteAsset).locked,
        );
        const lock = sub(bal(rested, spotMarket.quoteAsset).locked, bal(before, spotMarket.quoteAsset).locked);
        s.check(
          "locks the venue's amount",
          resting !== null && lock === resting.locked,
          `hold +${fmt(lock)}; the order locks ${resting ? fmt(resting.locked) : '-'}`,
        );
        const cancel = await act(trader, { kind: 'cancel_order', symbol: spotSymbol, clientOrderKey: k });
        s.ev('cancelOutcome', cancel.outcome);
        const cancelled = (
          await until(
            () => venue.orderByClientId(trader.account, cloid),
            (r) => r.value?.status === 'canceled',
          )
        ).value;
        const released = await until(
          () => balancesOf(trader),
          (b) => bal(b, spotMarket.quoteAsset).locked === bal(before, spotMarket.quoteAsset).locked,
        );
        s.check(
          'cancelled, lock released',
          cancelled?.status === 'canceled' && bal(released, spotMarket.quoteAsset).locked === bal(before, spotMarket.quoteAsset).locked,
          `status ${cancelled?.status ?? 'none'}; hold back to its value before (${fmt(bal(released, spotMarket.quoteAsset).locked)})`,
        );
        const signed = trader.signatures;
        const repeat = await venue.submit(cancel.prepared, cancel.signature);
        s.ev('repeatOutcome', repeat);
        const again = (await venue.orderByClientId(trader.account, cloid)).value;
        const same = (repeat.definite && repeat.accepted) || (!repeat.definite && again?.status === 'canceled');
        s.check(
          'repeat reports the same outcome',
          same && again?.status === 'canceled' && trader.signatures === signed,
          `first ${outcomeText(cancel.outcome)}; repeat ${outcomeText(repeat)}, read back ${again?.status ?? 'none'}; no new signature`,
        );
        s.summary(`cloid ${cloid}, rested at ${fmt(awayPrice)} locking ${fmt(lock)}, cancelled; repeat: ${outcomeText(repeat)}`);
      },
    );

    // ════════ J-derivatives-01 ════════
    const J2 = 'J-derivatives-01';
    const openIntent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: perpSymbol,
      side: 'buy',
      type: 'market',
      amount: openSize,
      price: openWorst,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: key('perp-8'),
      builderFee: { builder: builderParty.address, feeBps: BUILDER_FEE_BPS },
    };
    let perpBefore: readonly UserVenueBalance[] | null = null;

    // #1: the contracts the venue lists for this account, each with its venue named (a TEST venue).
    await step(
      J2,
      1,
      'opens /trade/futures: the contracts the venue lists, its venue named; a venue that is down is named and its controls refuse',
      'perp',
      async (s) => {
        const listed = (await venue.markets(trader.account)).value.filter((m) => m.kind === 'perpetual');
        s.ev('perpetuals', listed.length);
        s.check(
          'contracts listed',
          listed.some((m) => m.symbol === perpSymbol),
          `${listed.length} perpetual(s) listed, ${perpSymbol} among them`,
        );
        s.check(
          'venue named, TEST',
          venue.venue.proofLevel !== 'live' && venue.venue.displayName.length > 0,
          `${venue.venue.displayName} (${venue.venue.id}, proof level ${venue.venue.proofLevel})`,
        );
        s.skip('venue down', "the live venue cannot be taken down on demand; the simulator's journey shows it");
        s.summary(`${listed.length} perpetuals, ${perpSymbol} listed, venue ${venue.venue.displayName}`);
      },
    );

    // #5: the margin modes the venue offers for the contract; choosing one changes nothing; then the signed 10x
    // isolated setting, read back from the venue, with the balances unchanged.
    await step(
      J2,
      5,
      'chooses the margin mode: the modes the venue offers; nothing changes; the leverage is a signed setting on the venue',
      'perp',
      async (s) => {
        const before = await balancesOf(trader);
        perpBefore = before;
        const writes = exchangeWrites;
        const offered = perpMarket.marginModes;
        s.check(
          'modes offered',
          offered.includes('isolated'),
          `${perpSymbol}: ${offered.join(', ')}${offered.includes('cross') ? '' : '; cross not offered'}`,
        );
        const unchanged = await balancesOf(trader);
        s.check(
          'choosing changes nothing',
          exchangeWrites === writes && show(unchanged) === show(before),
          'no exchange write; balances as before',
        );
        const { outcome } = await act(trader, {
          kind: 'update_leverage',
          symbol: perpSymbol,
          leverageBps: LEVERAGE_BPS,
          marginMode: 'isolated',
        });
        s.ev('leverageOutcome', outcome);
        const lev = await until(
          () => venue.leverage(trader.account, perpSymbol),
          (r) => r.value?.leverageBps === LEVERAGE_BPS && r.value.marginMode === 'isolated',
        );
        s.check(
          'leverage set on the venue',
          lev.value?.leverageBps === LEVERAGE_BPS && lev.value.marginMode === 'isolated',
          `${show(lev.value)} (as of ${lev.asOf.toISOString()})`,
        );
        const after = await balancesOf(trader);
        s.check(
          'balances unchanged by the setting',
          bal(after, PERP_COLLATERAL_ASSET).total === bal(before, PERP_COLLATERAL_ASSET).total,
          `${PERP_COLLATERAL_ASSET} total ${fmt(bal(after, PERP_COLLATERAL_ASSET).total)}`,
        );
        s.summary(`modes ${offered.join('/')}, 10x isolated set (${outcomeText(outcome)})`);
      },
    );

    let openPreview: Preview | null = null;
    // #6: the review's figures from the venue: initial margin at 10x, the venue's taker fee, our builder fee, the
    // liquidation price (the venue publishes none before a position: "not known"), and the total to commit.
    await step(
      J2,
      6,
      "types a size and leverage and presses Review: initial margin, the venue's fee, our builder fee, liquidation price, the total",
      'perp',
      async (s) => {
        const book = (await venue.l2Book(perpSymbol)).value;
        const p = await preview(venue, trader.account, openIntent, perpMarket, book);
        openPreview = p;
        s.ev('preview', p);
        const margin = p.perpetual?.initialMargin;
        s.check(
          'initial margin',
          margin !== undefined && margin === div(mul(openWorst, openSize, 'ceil'), a('10'), 'ceil'),
          `${margin === undefined ? '-' : fmt(margin)} ${PERP_COLLATERAL_ASSET} (size x worst price / 10)`,
        );
        s.check(
          'fees',
          p.venueFee.known && p.builderFee.known && compare(p.builderFee.amount, ZERO) > 0,
          `venue ${fmt(p.venueFee.amount)} ${p.venueFee.asset}, builder ${fmt(p.builderFee.amount)} ${p.builderFee.asset}`,
        );
        s.pass('liquidation price', 'not known: the venue publishes a liquidation price for a position, not for an order');
        const total = add(margin ?? ZERO, add(p.venueFee.amount, p.builderFee.amount));
        s.pass('total to commit', `${fmt(total)} USDC`);
        s.check('settle asset', perpMarket.quoteAsset === 'USDC', `margin in ${perpMarket.quoteAsset}`);
        s.skip('margin-asset mismatch refused', "the app's own refusal, before the venue is asked");
        await ensureApproval(s, openIntent);
        const positions = (await venue.positions(trader.account)).value.filter((x) => x.symbol === perpSymbol);
        s.check('nothing opened', positions.length === 0, `${positions.length} ${perpSymbol} position(s)`);
        s.summary(
          `margin ${margin === undefined ? '-' : fmt(margin)}, venue fee ${fmt(p.venueFee.amount)}, builder fee ${fmt(p.builderFee.amount)}, liquidation not known, total ${fmt(total)} USDC`,
        );
      },
    );

    // #7: the order types the venue offers: market and limit; no resting type, and nothing is written.
    await step(
      J2,
      7,
      'looks at the order types: market and limit as offered; resting types not live, with no network write',
      'perp',
      async (s) => {
        const writes = exchangeWrites;
        const m = (await venue.markets(trader.account)).value.find((x) => x.symbol === perpSymbol)!;
        s.check('market and limit', show(m.orderTypes) === show(['limit', 'market']), m.orderTypes.join(', '));
        s.check(
          'no resting types',
          !m.orderTypes.some((t) => /stop|take|trail/i.test(t)),
          'stop, take profit and trailing stop are not offered',
        );
        s.check('no network write', exchangeWrites === writes, `${exchangeWrites - writes} exchange write(s)`);
        s.summary(`order types ${m.orderTypes.join('/')}`);
      },
    );

    // #8: the open long, signed once and pressed twice at once (the same stored bytes sent twice): one order, one
    // position of the size asked, long, isolated, 10x.
    await step(
      J2,
      8,
      'confirms Open long and signs: the venue opens one position; a double press asks for one signature and sends one order',
      'perp',
      async (s) => {
        const prepared = await venue.prepare(trader.account, trader.signer, openIntent);
        const signed = trader.signatures;
        const signature = await trader.sign(prepared);
        placed.push({ who: trader, symbol: perpSymbol, clientOrderKey: openIntent.clientOrderKey, cloid: prepared.venueClientOrderId! });
        perpOpened = true;
        const [first, second] = await Promise.all([venue.submit(prepared, signature), venue.submit(prepared, signature)]);
        s.ev('answers', [first, second]);
        const cloid = prepared.venueClientOrderId!;
        const fills = (
          await until(
            () => venue.fills(trader.account, started),
            (r) => sum(r.value.filter((f) => f.venueClientOrderId === cloid).map((f) => f.amount)) === openSize,
          )
        ).value.filter((f) => f.venueClientOrderId === cloid);
        s.ev('fills', fills);
        const filled = sum(fills.map((f) => f.amount));
        s.check(
          'one order',
          trader.signatures === signed + 1 && filled === openSize,
          `one signature; fills for the cloid sum to ${fmt(filled)} of ${fmt(openSize)}; answers ${outcomeText(first)} / ${outcomeText(second)}`,
        );
        const positions = (
          await until(
            () => venue.positions(trader.account),
            (r) => r.value.some((x) => x.symbol === perpSymbol),
          )
        ).value.filter((x) => x.symbol === perpSymbol);
        const pos = positions[0];
        s.ev('position', pos);
        s.check(
          'one position',
          positions.length === 1 &&
            pos!.size === openSize &&
            pos!.side === 'long' &&
            pos!.marginMode === 'isolated' &&
            pos!.leverageBps === LEVERAGE_BPS,
          pos ? `${pos.side} ${fmt(pos.size)} ${pos.marginMode} ${pos.leverageBps / 10_000}x` : 'none',
        );
        if (openPreview) {
          const venueFee = sum(fills.map((f) => f.venueFee));
          const builderFee = sum(fills.map((f) => f.builderFee));
          const atFill = await preview(venue, trader.account, openIntent, perpMarket, {
            symbol: perpSymbol,
            bids: [],
            asks: fills.map((f) => ({ price: f.price, size: f.amount })),
          });
          s.check(
            'fees at the published taker rate',
            within(venueFee, atFill.venueFee.amount) && within(builderFee, atFill.builderFee.amount) && compare(builderFee, ZERO) > 0,
            `venue ${fmt(venueFee)}, builder ${fmt(builderFee)}; at the fill prices the rates give ${fmt(atFill.venueFee.amount)} and ${fmt(atFill.builderFee.amount)}`,
          );
        }
        s.summary(
          `cloid ${cloid}, tid ${fills.map((f) => f.fillId).join(',')}, ${pos ? `${pos.side} ${fmt(pos.size)} at ${fmt(pos.entryPrice)}` : 'no position'}; second press: ${outcomeText(second)}`,
        );
      },
    );

    // #9: the position as the venue reports it: entry, mark, unrealised, margin, leverage and liquidation price as exact
    // decimals, with the venue's as-of time.
    await step(
      J2,
      9,
      'opens the positions room: entry, mark, unrealised result, margin, leverage and liquidation price as the venue reports them, with an as-of time',
      'perp',
      async (s) => {
        const read = await venue.positions(trader.account);
        const pos = read.value.find((x) => x.symbol === perpSymbol);
        s.ev('position', pos);
        s.ev('asOf', read.asOf);
        s.check(
          'position read',
          pos !== undefined && compare(pos.entryPrice, ZERO) > 0 && compare(pos.markPrice, ZERO) > 0 && compare(pos.margin, ZERO) > 0,
          pos
            ? `entry ${fmt(pos.entryPrice)}, mark ${fmt(pos.markPrice)}, unrealised ${fmt(pos.unrealisedPnl)}, margin ${fmt(pos.margin)}, ${pos.leverageBps / 10_000}x ${pos.marginMode}, liquidation ${pos.liquidationPrice.known ? fmt(pos.liquidationPrice.value) : 'not known'}`
            : 'none',
        );
        const skew = Math.abs(read.asOf.getTime() - clock().getTime());
        s.check('as-of time', skew < 5 * 60_000, `as of ${read.asOf.toISOString()}`);
        s.summary(
          pos
            ? `entry ${fmt(pos.entryPrice)}, mark ${fmt(pos.markPrice)}, upnl ${fmt(pos.unrealisedPnl)}, margin ${fmt(pos.margin)}, liq ${pos.liquidationPrice.known ? fmt(pos.liquidationPrice.value) : 'not known'}, as of ${read.asOf.toISOString()}`
            : 'no position',
        );
      },
    );

    // #11: the close (40 percent pressed twice at once: one signature, one order; then the rest), and History: the
    // closing fills sum to the position, with the realised result, the venue's fees and our builder fee.
    await step(
      J2,
      11,
      "opens History: the closed position with its realised result, the venue's fee and our builder fee, from the venue",
      'perp',
      async (s) => {
        const closeOrder = (k: string, amount: Amount): PlaceUserOrderIntent => ({
          kind: 'place_order',
          symbol: perpSymbol,
          side: 'sell',
          type: 'market',
          amount,
          price: worstBelow(perpBid, perpShape),
          timeInForce: 'IOC',
          reduceOnly: true,
          clientOrderKey: k,
          builderFee: { builder: builderParty.address, feeBps: BUILDER_FEE_BPS },
        });
        const partial = closeOrder(key('perp-11-part'), closePart);
        const prepared = await venue.prepare(trader.account, trader.signer, partial);
        const signed = trader.signatures;
        const signature = await trader.sign(prepared);
        placed.push({ who: trader, symbol: perpSymbol, clientOrderKey: partial.clientOrderKey, cloid: prepared.venueClientOrderId! });
        const answers = await Promise.all([venue.submit(prepared, signature), venue.submit(prepared, signature)]);
        s.ev('partialAnswers', answers);
        const rest = sub(openSize, closePart);
        const mid = await until(
          () => venue.positions(trader.account),
          (r) => r.value.find((x) => x.symbol === perpSymbol)?.size === rest,
        );
        const midSize = mid.value.find((x) => x.symbol === perpSymbol)?.size ?? ZERO;
        s.check(
          'partial close, one order',
          midSize === rest && trader.signatures === signed + 1,
          `position ${fmt(midSize)} after closing ${fmt(closePart)} (one signature)`,
        );
        const { outcome } = await act(trader, closeOrder(key('perp-11-rest'), rest));
        s.ev('restOutcome', outcome);
        const flat = await until(
          () => venue.positions(trader.account),
          (r) => !r.value.some((x) => x.symbol === perpSymbol),
        );
        s.check('closed', !flat.value.some((x) => x.symbol === perpSymbol), `no ${perpSymbol} position (as of ${flat.asOf.toISOString()})`);
        const runCloids = new Set([cloidOf(openIntent.clientOrderKey), cloidOf(partial.clientOrderKey), cloidOf(key('perp-11-rest'))]);
        const fills: UserVenueFill[] = (
          await until(
            () => venue.fills(trader.account, started),
            (r) =>
              sum(r.value.filter((f) => runCloids.has(f.venueClientOrderId ?? '') && f.realisedPnl !== null).map((f) => f.amount)) ===
              openSize,
          )
        ).value.filter((f) => runCloids.has(f.venueClientOrderId ?? ''));
        s.ev('fills', fills);
        const closing = fills.filter((f) => f.realisedPnl !== null);
        const closed = sum(closing.map((f) => f.amount));
        const realised = sum(closing.map((f) => f.realisedPnl!));
        const venueFees = sum(fills.map((f) => f.venueFee));
        const builderFees = sum(fills.map((f) => f.builderFee));
        s.check(
          'closing fills sum to the position',
          closed === openSize,
          `${fmt(closed)} of ${fmt(openSize)} in ${closing.length} fill(s)`,
        );
        s.check(
          'history figures',
          compare(builderFees, ZERO) > 0,
          `realised ${fmt(realised)}, venue fees ${fmt(venueFees)}, builder fees ${fmt(builderFees)} USDC`,
        );
        const after = await balancesOf(trader);
        if (perpBefore) {
          const dLocked = sub(bal(after, PERP_COLLATERAL_ASSET).locked, bal(perpBefore, PERP_COLLATERAL_ASSET).locked);
          s.check('nothing held after', dLocked === ZERO, `${PERP_COLLATERAL_ASSET} held change ${fmt(dLocked)}`);
        }
        perpOpened = false;
        s.summary(
          `closed ${fmt(closePart)} + ${fmt(rest)}; tid ${closing.map((f) => f.fillId).join(',')}; realised ${fmt(realised)}, venue fees ${fmt(venueFees)}, builder fees ${fmt(builderFees)} USDC`,
        );
      },
    );

    // ════════ J-cex-spot-01 #12, after the perp close so nothing else moves the perp balance ════════
    // A small USDC-PERP withdrawal to the trader's own address, signed by the owner: the venue's record reaches
    // pending with its fee, and the free balance falls by the amount. Settlement is the bridge's.
    // A position left open by a failed perp step is closed first, so it does not move the perp balance under the check.
    if (perpOpened) await closePerp();
    await step(J1, 12, 'withdraws USDC from the venue to the wallet: the wallet signs; pending, with its fee', 'withdraw', async (s) => {
      let before = await balancesOf(trader);
      const free = bal(before, PERP_COLLATERAL_ASSET).free;
      if (compare(free, withdrawAmount) < 0) {
        await classTransfer(trader, add(sub(withdrawAmount, free), a('1')), true);
        before = await balancesOf(trader);
      }
      const { prepared, outcome } = await act(trader, {
        kind: 'withdraw',
        asset: PERP_COLLATERAL_ASSET,
        amount: withdrawAmount,
        destination: trader.address,
        withdrawalKey: key('withdraw-12'),
      });
      s.ev('outcome', outcome);
      s.check('the venue accepted it', outcome.definite && outcome.accepted, outcomeText(outcome));
      const record = await until(
        () => venue.withdrawal(trader.account, prepared.nonce),
        (r) => r.value !== null,
      );
      const w = record.value;
      s.ev('withdrawal', w);
      s.check(
        'pending, with its fee',
        w !== null && w.status === 'pending' && w.fee.known && w.amount === withdrawAmount && w.destination === trader.address,
        w
          ? `nonce ${w.nonce}, ${fmt(w.amount)} ${w.asset} to ${w.destination}, ${w.status}, fee ${w.fee.known ? fmt(w.fee.value) : 'not known'} (as of ${record.asOf.toISOString()})`
          : 'no record',
      );
      const after = await balancesOf(trader);
      const dFree = sub(bal(before, PERP_COLLATERAL_ASSET).free, bal(after, PERP_COLLATERAL_ASSET).free);
      s.check('free balance fell by it', compare(dFree, withdrawAmount) >= 0, `${PERP_COLLATERAL_ASSET} free -${fmt(dFree)}`);
      s.skip('done', "the bridge settles the withdrawal on its own chain; the venue's record shows the debit, not the payout");
      s.skip('refused without step-up', "the app's own refusal, before the wallet is asked");
      s.summary(
        w ? `nonce ${w.nonce}, ${fmt(w.amount)} ${w.asset}, ${w.status}, fee ${w.fee.known ? fmt(w.fee.value) : 'not known'}` : 'no record',
      );
    });

    // ════════ probe:agent-cannot-move-funds, after the perp close and the withdrawal ════════
    await agentProbe();
  } catch (error) {
    if (error instanceof Refused && steps.length === 0 && exchangeWrites === 0) {
      err(`live steps refused: ${error.message}`);
      exit = 2;
    } else {
      // A key never reaches an error message: only venue answers and our own words do.
      stopped = `the run stopped: ${(error as Error).message}`;
      err(`live steps stopped: ${(error as Error).message}`);
      exit = 1;
    }
  } finally {
    // ── leave nothing open, whatever happened above ──
    for (const p of placed) {
      try {
        const o = (await venue.orderByClientId(p.who.account, p.cloid)).value;
        if (o && (o.status === 'open' || o.status === 'partially_filled')) {
          const c = await act(p.who, { kind: 'cancel_order', symbol: p.symbol, clientOrderKey: p.clientOrderKey });
          const back = (
            await until(
              () => venue.orderByClientId(p.who.account, p.cloid),
              (r) => r.value?.status === 'canceled',
            )
          ).value;
          const line = `cancelled ${p.who.name}'s ${p.symbol} order ${p.cloid}: ${outcomeText(c.outcome)}, read back ${back?.status ?? 'none'}`;
          cleanupLog.push(line);
          out(`cleanup: ${line}`);
          if (back?.status !== 'canceled') leftOpen = true;
        }
      } catch (error) {
        leftOpen = true;
        const line = `could not cancel ${p.who.name}'s ${p.symbol} order ${p.cloid}: ${(error as Error).message}`;
        cleanupLog.push(line);
        out(`cleanup: ${line}`);
      }
    }
    if (perpOpened) await closePerp();
    if (cleanupLog.length === notes && exit !== 2) out('cleanup: nothing left open by this run');
  }

  return finish(exit);

  function finish(exit: LiveStepsExit): LiveStepsExit {
    if (exit === 2) return 2;
    const failed = steps.filter((x) => x.verdict === 'FAIL').length;
    const skipped = steps.filter((x) => x.verdict === 'SKIPPED').length;
    const evidence = {
      note: 'TEST: the Hyperliquid testnet. Holds addresses and venue records only, never a key.',
      runId,
      venue: { id: venue.venue.id, displayName: venue.venue.displayName, baseUrl },
      startedAt: started,
      finishedAt: clock(),
      addresses: probeOnly
        ? { trader: trader.address, agent: agent.address }
        : { trader: trader.address, agent: agent.address, other: other.address, builder: builderParty.address },
      settings: settingsShown,
      setup: setupLog,
      steps,
      cleanup: cleanupLog,
      stopped,
      leftOpen,
    };
    try {
      writeFileSync(evidencePath, `${show(evidence)}\n`);
      out(`evidence: ${evidencePath}`);
    } catch (error) {
      err(`the evidence file could not be written (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
      exit = 1;
    }
    out(
      `${steps.length} steps: ${steps.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped${leftOpen ? '; SOMETHING WAS LEFT OPEN' : ''}`,
    );
    return exit === 1 || failed > 0 || leftOpen ? 1 : 0;
  }
}

// ── one step's checks ───────────────────────────────────────────────────────

class StepContext {
  private summaryText = '';
  constructor(private readonly record: StepRecord) {}
  check(name: string, ok: boolean, detail: string): void {
    this.record.checks.push({ name, verdict: ok ? 'PASS' : 'FAIL', detail });
    if (!ok) throw new CheckFailed(`${name}: ${detail}`);
  }
  /** A check that does not stop the step: the rest of its checks still run and are recorded. */
  assess(name: string, ok: boolean, detail: string): void {
    this.record.checks.push({ name, verdict: ok ? 'PASS' : 'FAIL', detail });
  }
  pass(name: string, detail: string): void {
    this.record.checks.push({ name, verdict: 'PASS', detail });
  }
  fail(name: string, detail: string): never {
    this.check(name, false, detail);
    throw new CheckFailed(name);
  }
  skip(name: string, reason: string): void {
    this.record.checks.push({ name, verdict: 'SKIPPED', detail: reason });
  }
  ev(key: string, value: unknown): void {
    this.record.evidence[key] = value;
  }
  summary(text: string): void {
    this.summaryText = text;
    this.record.evidence.summary = text;
  }
}

function lineOf(r: StepRecord): string {
  const head = `${r.verdict.padEnd(7)} ${r.n > 0 ? `${r.journey} #${r.n}` : r.journey}`;
  const skipped = r.checks.filter((c) => c.verdict === 'SKIPPED');
  const skippedText = skipped.length ? `; skipped: ${skipped.map((c) => `${c.name} (${c.detail})`).join('; ')}` : '';
  if (r.verdict === 'FAIL') {
    const failed = r.checks.filter((c) => c.verdict === 'FAIL');
    return `${head}  ${failed.map((c) => `${c.name}: ${c.detail}`).join('; ')}`;
  }
  const summary = typeof r.evidence.summary === 'string' ? r.evidence.summary : '';
  return `${head}  ${summary ? `${summary}${skippedText}` : skippedText.replace(/^; /, '')}`.trimEnd();
}

/**
 * What a refusal's wording suggests, for the agent probe: that the venue bars an agent from moving funds, or that it
 * read the action as the agent's own account's and found it empty. Anything else is "unclear"; the words themselves are
 * the evidence, and this is only a reading of them.
 */
export function suggestsFrom(words: string): 'agent not allowed' | "agent's own account has no funds" | 'unclear' {
  if (/insufficient|not enough|no funds|balance|does not exist|doesn't exist|unknown user/i.test(words))
    return "agent's own account has no funds";
  if (/agent|api wallet|not allowed|not permitted|permission|unauthori[sz]ed|not authori[sz]ed|cannot|can't|must be signed by/i.test(words))
    return 'agent not allowed';
  return 'unclear';
}

/** Every asset whose free, locked or total figure differs between two balance reads, as "<asset> <field> <before> -> <after> (+/-change)". */
export function balanceChanges(before: readonly UserVenueBalance[], after: readonly UserVenueBalance[]): string[] {
  const assets = [...new Set([...before, ...after].map((b) => b.asset))].sort();
  const changes: string[] = [];
  for (const asset of assets) {
    const x = bal(before, asset);
    const y = bal(after, asset);
    for (const field of ['total', 'free', 'locked'] as const) {
      if (x[field] === y[field]) continue;
      const d = sub(y[field], x[field]);
      changes.push(`${asset} ${field} ${fmt(x[field])} -> ${fmt(y[field])} (${compare(d, ZERO) > 0 ? '+' : ''}${fmt(d)})`);
    }
  }
  return changes;
}

function outcomeText(o: VenueSubmitOutcome): string {
  if (!o.definite) return `not definite (${o.reason})`;
  if (o.accepted) return `accepted${o.venueRef ? ` (oid ${o.venueRef})` : ''}`;
  return `refused ${o.refusal.code}: ${o.refusal.detail}`;
}

// ── prices and the preview ──────────────────────────────────────────────────

/** A valid price strictly inside the spread, at or below the mid. */
export function insidePrice(book: HlBook, m: MarketShape): Amount | null {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (bid === undefined || ask === undefined) return null;
  return validPriceAtOrBelow(div(add(bid, ask), a('2'), 'floor'), m, (p) => compare(p, bid) > 0 && compare(p, ask) < 0);
}

/** A buy's worst price: a valid price at or below 5 percent over the touch, and not below it. */
export function worstAbove(touch: Amount, m: MarketShape): Amount {
  return validPriceAtOrBelow(mul(touch, SLIPPAGE_UP, 'floor'), m, (p) => compare(p, touch) >= 0) ?? touch;
}

/** A sell's worst price: a valid price at or below 5 percent under the touch. */
export function worstBelow(touch: Amount, m: MarketShape): Amount {
  return validPriceAtOrBelow(mul(touch, SLIPPAGE_DOWN, 'floor'), m, () => true) ?? touch;
}

async function pickSpot(venue: HyperliquidTestnetUserVenue, markets: readonly UserVenueMarket[]): Promise<string> {
  const candidates = markets
    .filter((m) => m.kind === 'spot' && m.quoteAsset === 'USDC' && !m.symbol.includes('@'))
    .map((m) => m.symbol)
    .sort()
    .slice(0, 8);
  for (const symbol of candidates) {
    const shape = await marketShape(venue, symbol);
    const book = (await venue.l2Book(symbol)).value;
    if (insidePrice(book, shape) !== null && probePriceFar(book, shape) !== null) return symbol;
  }
  throw new Refused(
    `no USDC spot pair on the testnet has room inside its spread (tried ${candidates.join(', ') || 'none'}); set HL_SPOT_SYMBOL`,
  );
}

/**
 * What an order would lock and cost now, from the venue's own figures: the fee rates it publishes for this account
 * (`userFees`, through `markets(account)`), its book and the account's leverage. Nothing is prepared or sent.
 *
 * Stands in for `UserVenue.preview`, which is added with the venue door (branch t3/b1-venue-desks) and which this
 * adapter does not implement yet; the shape is that one's. The part that meets the book is charged the taker rate at
 * the book's prices, the rest the maker rate at the limit; an IOC's unfilled rest pays nothing. A spot buy's fee is in
 * the base (the venue charges the asset received), every other fee in the quote.
 */
export interface Preview {
  readonly symbol: string;
  readonly kind: 'spot' | 'perpetual';
  readonly lock: { readonly asset: string; readonly amount: Amount };
  readonly role: 'maker' | 'taker';
  readonly venueFee: { readonly known: boolean; readonly asset: string; readonly amount: Amount };
  readonly builderFee: { readonly known: boolean; readonly asset: string; readonly amount: Amount };
  readonly perpetual: { readonly leverageBps: number; readonly marginMode: string; readonly initialMargin: Amount } | null;
}

export async function preview(
  venue: HyperliquidTestnetUserVenue,
  account: UserVenueAccount,
  intent: PlaceUserOrderIntent,
  market: UserVenueMarket,
  book: HlBook,
): Promise<Preview> {
  const buy = intent.side === 'buy';
  const ioc = intent.type === 'market' || intent.timeInForce === 'IOC';
  const levels = buy ? book.asks : book.bids;
  let left = intent.amount;
  let takerQty = ZERO;
  let takerNotional = ZERO;
  for (const l of levels) {
    if (compare(left, ZERO) <= 0) break;
    if (buy ? compare(l.price, intent.price) > 0 : compare(l.price, intent.price) < 0) break;
    const q = compare(l.size, left) < 0 ? l.size : left;
    takerQty = add(takerQty, q);
    takerNotional = add(takerNotional, mul(l.price, q, 'half-up'));
    left = sub(left, q);
  }
  const makerQty = ioc ? ZERO : left;
  const makerNotional = mul(intent.price, makerQty, 'half-up');
  const spotBuy = market.kind === 'spot' && buy;
  const feeAsset = spotBuy ? market.baseAsset : market.quoteAsset;
  const takerBasis = spotBuy ? takerQty : takerNotional;
  const makerBasis = spotBuy ? makerQty : makerNotional;
  const known = market.makerFeeBps.known && market.takerFeeBps.known;
  const venueFee = known
    ? add(
        bpsOf(takerBasis, (market.takerFeeBps as { value: Amount }).value),
        bpsOf(makerBasis, (market.makerFeeBps as { value: Amount }).value),
      )
    : ZERO;
  const builderFee = intent.builderFee ? bpsOf(add(takerBasis, makerBasis), intent.builderFee.feeBps) : ZERO;
  let perpetual: Preview['perpetual'] = null;
  let lock: Preview['lock'];
  if (market.kind === 'perpetual') {
    const lev = (await venue.leverage(account, intent.symbol)).value;
    if (!lev) throw new Error(`${intent.symbol}: no leverage set on the venue`);
    const initialMargin = intent.reduceOnly
      ? ZERO
      : div(mul(intent.price, intent.amount, 'ceil'), a(String(lev.leverageBps / 10_000)), 'ceil');
    perpetual = { leverageBps: lev.leverageBps, marginMode: lev.marginMode, initialMargin };
    lock = { asset: PERP_COLLATERAL_ASSET, amount: initialMargin };
  } else {
    lock = buy
      ? { asset: market.quoteAsset, amount: mul(intent.price, intent.amount, 'ceil') }
      : { asset: market.baseAsset, amount: intent.amount };
  }
  return {
    symbol: intent.symbol,
    kind: market.kind,
    lock,
    role: ioc || compare(takerQty, ZERO) > 0 ? 'taker' : 'maker',
    venueFee: { known, asset: feeAsset, amount: venueFee },
    builderFee: { known: true, asset: feeAsset, amount: builderFee },
    perpetual,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveSteps({
    env: process.env,
    argv: process.argv.slice(2),
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // A key never reaches an error message: only venue answers and our own words do.
      process.stderr.write(`live steps stopped: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
