/**
 * FAUCET ACTIVATE — makes one fresh address eligible for Hyperliquid's testnet faucet, claims its TEST USDC and moves
 * it to the platform's TESTNET funder. The one piece of this package that acts on mainnet, and only once per run.
 *
 *   APP_ENV=test HL_TESTNET_FUNDER_KEY=0x… HL_ACTIVATIONS_TODAY=0 \
 *     pnpm --filter @intafaced/venue-hyperliquid faucet:activate
 *
 * Why (intafaced#11043): the testnet faucet (`claimDrip`) pays 1,000 TEST USDC once per address, and only to an address
 * that exists on mainnet. The funder spent its claim on 19 Nov 2026; grants to testers never come back. An address
 * exists on mainnet once it receives anything there, and the venue charges the sender a 1 USDC activation fee for a
 * new account. The owner allowed about 2 USDC of the platform account's mainnet balance for this, two runs
 * (the owner decision cited in .github/workflows/hl-faucet-activate.yml).
 *
 * 1. Refuses before anything is sent (exit 2): APP_ENV other than dev or test, a funder key that isn't 32-byte hex,
 *    HL_ACTIVATIONS_TODAY missing or at `MAX_RUNS_PER_DAY`, an amount other than at most `MAX_MAINNET_SEND_USDC`.
 * 2. Makes a fresh key in memory. It is never printed, stored or written, and dies with the run.
 * 3. Reads the funder's mainnet USDC; refuses under `MAX_MAINNET_SPEND_USDC` (exit 1). Sends the fresh address
 *    0.01 USDC on mainnet with one `sendAsset` spot to spot (the account is unified: intafaced#10293). `MainnetOnce`
 *    lets exactly that one action reach mainnet's /exchange: a second action, another type or a larger amount refuses.
 *    No fallback: a refused send stops the run.
 * 4. Waits until the fresh address shows the cent on mainnet, claims its drip on the testnet, waits for the TEST USDC,
 *    and sends all of it to the funder on the testnet, signed by the fresh key.
 * 5. Reads the funder's mainnet USDC again; a drop over `MAX_MAINNET_SPEND_USDC` exits 1 and says so.
 * Prints only addresses, amounts and the venue's answers.
 */
import { pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { compare, formatAmount, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  HL_TESTNET_API_URL,
  HyperliquidTestnetUserVenue,
  USER_SIGNED_TYPES,
  recoverTypedDataSigner,
  spotSendAction,
  splitSignature,
  typedDataDigest,
  usdSendAction,
  type FetchLike,
  type UserSignedTypedData,
} from '../src/index.js';
import { isHexKey } from './live-settings.js';
import { postExchange } from './testnet-setup.js';
import { perpUsdcFree, spotUsdcFree, wantsPerps } from './testnet-send.js';

export const HL_MAINNET_API_URL = 'https://api.hyperliquid.xyz';
/** The testnet faucet's door: what app.hyperliquid-testnet.xyz/drip posts to (tooling/beta/beta-testnet.mjs). */
export const HL_TESTNET_DRIP_URL = 'https://api-ui.hyperliquid-testnet.xyz/info';
/** The one mainnet send's amount, and its cap. Real USDC. */
export const MAX_MAINNET_SEND_USDC = parseAmount('0.01');
/** The most one run may take from the mainnet account: the send, the venue's 1 USDC activation fee, a cent of slack. */
export const MAX_MAINNET_SPEND_USDC = parseAmount('1.02');
/** Runs per UTC day, this one included. */
export const MAX_RUNS_PER_DAY = 2;
/** Arbitrum One: the chain id the venue's own front signs mainnet user actions under. */
const MAINNET_SIGNATURE_CHAIN_ID = '0xa4b1';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CENT_STEP = 10n ** 16n;

export interface ActivateDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The fresh key; made here when absent. Tests pass a TEST key. */
  readonly freshKey?: `0x${string}`;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Exit codes: 0 the funder was credited, 1 a step failed or the spend went over its cap, 2 refused before anything was sent. */
export type ActivateExit = 0 | 1 | 2;

export class ActivationRefusal extends Error {}

/** The run's inputs, checked. Throws `ActivationRefusal` naming the one input that is wrong; never echoes the key. */
export function readActivateInputs(env: Readonly<Record<string, string | undefined>>): { key: `0x${string}`; amountText: string } {
  const raw = (env.HL_TESTNET_FUNDER_KEY ?? '').trim();
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? `0x${raw}` : raw;
  if (!key) throw new ActivationRefusal("HL_TESTNET_FUNDER_KEY is not set: the platform account's key (the HL_TESTNET_TRADER_KEY secret).");
  if (!isHexKey(key)) throw new ActivationRefusal('HL_TESTNET_FUNDER_KEY is not a 32-byte hex key (its value is not shown).');
  const today = (env.HL_ACTIVATIONS_TODAY ?? '').trim();
  if (!/^\d+$/.test(today)) throw new ActivationRefusal(`HL_ACTIVATIONS_TODAY must be the count of earlier runs today (got "${today}").`);
  if (Number(today) >= MAX_RUNS_PER_DAY)
    throw new ActivationRefusal(`${today} runs already today; at most ${MAX_RUNS_PER_DAY} a day spend mainnet USDC.`);
  const amountText = (env.HL_ACTIVATE_AMOUNT ?? '0.01').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(amountText) || /^0+(\.0+)?$/.test(amountText))
    throw new ActivationRefusal(`HL_ACTIVATE_AMOUNT must be a positive USDC amount with at most 2 decimals (got "${amountText}").`);
  if (compare(parseAmount(amountText), MAX_MAINNET_SEND_USDC) > 0)
    throw new ActivationRefusal(
      `HL_ACTIVATE_AMOUNT ${amountText} is above the cap of ${formatAmount(MAX_MAINNET_SEND_USDC)} mainnet USDC per run.`,
    );
  return { key, amountText };
}

/** The mainnet `sendAsset` spot to spot, as the venue's SDK builds it, with `hyperliquidChain: "Mainnet"`. */
export function mainnetSendAsset(
  destination: string,
  token: string,
  amountText: string,
  nonce: bigint,
): { action: Record<string, string | number>; typedData: UserSignedTypedData } {
  if (!ADDRESS_RE.test(destination)) throw new ActivationRefusal(`not an address: ${destination}`);
  if (compare(parseAmount(amountText), MAX_MAINNET_SEND_USDC) > 0)
    throw new ActivationRefusal(`a mainnet send of ${amountText} is above the cap of ${formatAmount(MAX_MAINNET_SEND_USDC)}`);
  const signed = {
    destination: destination.toLowerCase(),
    sourceDex: 'spot',
    destinationDex: 'spot',
    token,
    amount: amountText,
    fromSubAccount: '',
  };
  const fields = USER_SIGNED_TYPES['HyperliquidTransaction:SendAsset'];
  const message: Record<string, string | bigint> = { hyperliquidChain: 'Mainnet', ...signed, nonce };
  const typedData: UserSignedTypedData = {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: Number.parseInt(MAINNET_SIGNATURE_CHAIN_ID, 16),
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: { 'HyperliquidTransaction:SendAsset': fields },
    primaryType: 'HyperliquidTransaction:SendAsset',
    message: Object.fromEntries(fields.map((f) => [f.name, message[f.name]!])),
  };
  const action = {
    type: 'sendAsset',
    signatureChainId: MAINNET_SIGNATURE_CHAIN_ID,
    hyperliquidChain: 'Mainnet',
    ...signed,
    nonce: Number(nonce),
  };
  return { action, typedData };
}

/**
 * The only door to mainnet's /exchange: one `sendAsset` per run, of at most the cap, to one address. Anything else, and
 * any second action, throws `ActivationRefusal` before a byte is sent.
 */
export class MainnetOnce {
  private used = false;
  constructor(private readonly fetchImpl: FetchLike) {}

  async send(signer: PrivateKeyAccount, destination: string, token: string, amountText: string, nonce: bigint) {
    if (this.used) throw new ActivationRefusal('a second mainnet action in one run is refused; one send per run.');
    const { action, typedData } = mainnetSendAsset(destination, token, amountText, nonce);
    this.used = true;
    const signature = await signer.sign({ hash: typedDataDigest(typedData) });
    if ((await recoverTypedDataSigner(typedData, signature)) !== signer.address.toLowerCase())
      throw new ActivationRefusal('the mainnet signature does not recover the funder; not sent.');
    return postExchange(
      this.fetchImpl,
      HL_MAINNET_API_URL,
      JSON.stringify({ action, nonce: Number(nonce), signature: splitSignature(signature), vaultAddress: null, expiresAfter: null }),
    );
  }
}

async function info(fetchImpl: FetchLike, url: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${String(body.type)}: HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function mainnetUsdcToken(fetchImpl: FetchLike): Promise<string> {
  const meta = (await info(fetchImpl, `${HL_MAINNET_API_URL}/info`, { type: 'spotMeta' })) as {
    tokens?: { name?: unknown; tokenId?: unknown }[];
  };
  const usdc = meta.tokens?.find((t) => t.name === 'USDC');
  if (!usdc || typeof usdc.tokenId !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(usdc.tokenId))
    throw new Error("mainnet's spotMeta lists no tokenId for USDC");
  return `USDC:${usdc.tokenId}`;
}

/** Spot USDC total of `user` on mainnet (the unified account's one balance). */
async function mainnetUsdc(fetchImpl: FetchLike, user: string): Promise<Amount> {
  return spotUsdcFree(fetchImpl, HL_MAINNET_API_URL, user);
}

const floorCents = (a: Amount): Amount => (a / CENT_STEP) * CENT_STEP;

export async function runActivate(deps: ActivateDeps): Promise<ActivateExit> {
  const { env, out, err } = deps;
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const testnet = HL_TESTNET_API_URL;

  let inputs: ReturnType<typeof readActivateInputs>;
  try {
    // The adapter's own refusal: APP_ENV must be exactly dev or test.
    new HyperliquidTestnetUserVenue({ appEnv: env.APP_ENV, baseUrl: testnet, fetch: fetchImpl });
    inputs = readActivateInputs(env);
  } catch (error) {
    err(`faucet activate refused: ${(error as Error).message}`);
    return 2;
  }
  const funder = privateKeyToAccount(inputs.key);
  const funderAddr = funder.address.toLowerCase();
  const fresh = privateKeyToAccount(deps.freshKey ?? generatePrivateKey());
  const freshAddr = fresh.address.toLowerCase();
  out(`faucet activate: funder ${funderAddr}, fresh address ${freshAddr} (its key lives only in this run)`);

  // Reads first; nothing has moved if any of them fails.
  let mainBefore: Amount;
  let token: string;
  let funderTestPerps: boolean;
  let funderTestBefore: Amount;
  try {
    mainBefore = await mainnetUsdc(fetchImpl, funderAddr);
    token = await mainnetUsdcToken(fetchImpl);
    funderTestPerps = await wantsPerps(fetchImpl, testnet, funderAddr);
    funderTestBefore = await (funderTestPerps ? perpUsdcFree : spotUsdcFree)(fetchImpl, testnet, funderAddr);
  } catch (error) {
    err(`faucet activate stopped: could not read the venue (${(error as Error).message}); nothing was sent.`);
    return 1;
  }
  out(`before: funder ${formatAmount(mainBefore)} USDC on MAINNET, ${formatAmount(funderTestBefore)} TEST USDC on the testnet`);
  if (compare(mainBefore, MAX_MAINNET_SPEND_USDC) < 0) {
    err(
      `faucet activate refused: the funder holds ${formatAmount(mainBefore)} USDC on mainnet, under ${formatAmount(MAX_MAINNET_SPEND_USDC)}; nothing was sent.`,
    );
    return 1;
  }

  // The one mainnet action.
  const mainnet = new MainnetOnce(fetchImpl);
  const verdict = await mainnet.send(funder, freshAddr, token, inputs.amountText, BigInt(clock().getTime()));
  out(`MAINNET sendAsset ${inputs.amountText} USDC -> ${freshAddr}: ${verdict.text}`);
  const spentCheck = async (): Promise<boolean> => {
    let after: Amount;
    try {
      after = await mainnetUsdc(fetchImpl, funderAddr);
    } catch (error) {
      err(`faucet activate: could not re-read the funder's mainnet USDC (${(error as Error).message}); check it by hand.`);
      return false;
    }
    const spent = sub(mainBefore, after);
    out(`mainnet: funder ${formatAmount(after)} USDC, spent ${formatAmount(spent)} (cap ${formatAmount(MAX_MAINNET_SPEND_USDC)})`);
    if (compare(spent, MAX_MAINNET_SPEND_USDC) > 0) {
      err(`faucet activate: the mainnet spend ${formatAmount(spent)} is over the cap of ${formatAmount(MAX_MAINNET_SPEND_USDC)}.`);
      return false;
    }
    return true;
  };
  // A refusal moved nothing; an unreadable answer may have landed, which the read below decides.
  if (!verdict.ok && verdict.text.startsWith('refused')) {
    await spentCheck();
    return 1;
  }

  // The cent lands on mainnet; then the address exists there.
  let landed = false;
  for (let i = 0; i < 30 && !landed; i += 1) {
    try {
      landed = compare(await mainnetUsdc(fetchImpl, freshAddr), ZERO) > 0;
    } catch {
      // read again
    }
    if (!landed) await sleep(2_000);
  }
  if (!landed) {
    err(`faucet activate: ${freshAddr} shows no USDC on mainnet after 30 reads; not claiming.`);
    await spentCheck();
    return 1;
  }

  // The faucet claim, retried while the testnet has not yet seen the mainnet account.
  let claimed: Amount = ZERO;
  let freshPerps = true;
  for (let i = 0; i < 20 && compare(claimed, ZERO) === 0; i += 1) {
    if (i % 4 === 0) {
      try {
        const answer = await info(fetchImpl, HL_TESTNET_DRIP_URL, { type: 'claimDrip', user: freshAddr });
        out(`claimDrip ${freshAddr}: ${typeof answer === 'string' ? answer : JSON.stringify(answer)}`);
      } catch (error) {
        out(`claimDrip ${freshAddr}: ${(error as Error).message}`);
      }
    }
    try {
      const perps = await perpUsdcFree(fetchImpl, testnet, freshAddr);
      const spot = await spotUsdcFree(fetchImpl, testnet, freshAddr);
      freshPerps = compare(perps, spot) >= 0;
      claimed = freshPerps ? perps : spot;
    } catch {
      // read again
    }
    if (compare(claimed, ZERO) === 0) await sleep(3_000);
  }
  if (compare(claimed, ZERO) === 0) {
    err(`faucet activate: the faucet paid ${freshAddr} nothing after 5 claims; its cent on mainnet stays there.`);
    await spentCheck();
    return 1;
  }
  const where = freshPerps ? 'perps' : 'spot';
  const amount = floorCents(claimed);
  out(`testnet: ${freshAddr} holds ${formatAmount(claimed)} TEST USDC (${where}); sending ${formatAmount(amount)} to the funder`);

  // The fresh key sends it all to the funder, on the testnet only (the builders refuse any other chain).
  const nonce = BigInt(clock().getTime());
  const amountText = formatAmount(amount);
  let testToken = '';
  if (!freshPerps) {
    const meta = (await info(fetchImpl, `${testnet}/info`, { type: 'spotMeta' })) as { tokens?: { name?: unknown; tokenId?: unknown }[] };
    const usdc = meta.tokens?.find((t) => t.name === 'USDC');
    testToken = `USDC:${String(usdc?.tokenId ?? '')}`;
  }
  const { action, typedData } = freshPerps
    ? usdSendAction(funderAddr, amountText, nonce)
    : spotSendAction(funderAddr, testToken, amountText, nonce);
  const signature = await fresh.sign({ hash: typedDataDigest(typedData) });
  const sent = await postExchange(
    fetchImpl,
    testnet,
    JSON.stringify({ action, nonce: Number(nonce), signature: splitSignature(signature), vaultAddress: null, expiresAfter: null }),
  );
  out(`testnet ${String(action.type)} ${amountText} TEST USDC ${freshAddr} -> ${funderAddr}: ${sent.text}`);

  let funderTestAfter = funderTestBefore;
  for (let i = 0; i < 10 && sent.ok; i += 1) {
    try {
      funderTestAfter = await (funderTestPerps ? perpUsdcFree : spotUsdcFree)(fetchImpl, testnet, funderAddr);
    } catch {
      // read again
    }
    if (compare(sub(funderTestAfter, funderTestBefore), amount) >= 0) break;
    await sleep(1_000);
  }
  out(`after: funder ${formatAmount(funderTestAfter)} TEST USDC on the testnet (was ${formatAmount(funderTestBefore)})`);
  const withinCap = await spentCheck();
  if (!sent.ok || compare(sub(funderTestAfter, funderTestBefore), amount) < 0) {
    err(`faucet activate: the funder was not seen credited ${amountText}; the TEST USDC may stay at ${freshAddr}.`);
    return 1;
  }
  return withinCap ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runActivate({ env: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // A key never reaches an error message: only venue answers and our own words do.
      process.stderr.write(`faucet activate stopped: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
