/**
 * TESTNET SEND — moves capped TEST USDC from the platform's funded TESTNET account to one address. Never mainnet.
 *
 *   APP_ENV=test HL_TESTNET_FUNDER_KEY=0x… HL_SEND_TO=0x… HL_SEND_AMOUNT=100 \
 *     pnpm --filter @intafaced/venue-hyperliquid testnet:send
 *
 * Run by the dispatch-only workflow `.github/workflows/hl-testnet-send.yml`, which passes the funded account's key from
 * the `HL_TESTNET_TRADER_KEY` secret. Hyperliquid's testnet faucet pays only addresses that have deposited on mainnet,
 * so a fresh testnet address (a box's platform key, a tester's wallet: intafaced#10204) gets its TEST USDC this way.
 *
 * 1. Refuses before anything is sent (exit 2): a URL that isn't the testnet's, APP_ENV other than dev or test, a key
 *    that isn't 32-byte hex, a destination that isn't a 0x address or is the funder itself, an amount that isn't a
 *    positive decimal with at most 2 decimals, or one above `MAX_SEND_USDC`.
 * 2. Reads the funder's free spot USDC on the testnet; refuses when it holds less than the amount (exit 1).
 * 3. Signs a user-signed `spotSend` of USDC (the token named by the venue's own spotMeta) and posts it. A unified
 *    account refuses `spotSend`; then `usdSend`, then `sendAsset` spot to spot, each only after the destination reads
 *    unchanged.
 * 4. Reads the destination's spot USDC again until it has risen by the amount, or a short wait runs out.
 * Prints only addresses, amounts and the venue's answers. The key is never printed, logged or written.
 */
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { add, compare, formatAmount, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  HL_TESTNET_API_URL,
  InMemoryNonceSource,
  HyperliquidTestnetUserVenue,
  assertTestnetUrl,
  recoverTypedDataSigner,
  sendAssetAction,
  spotSendAction,
  usdSendAction,
  splitSignature,
  typedDataDigest,
  type FetchLike,
  type HyperliquidNonceSource,
} from '../src/index.js';
import { isHexKey } from './live-settings.js';
import { postExchange } from './testnet-setup.js';

/** The most one run may send. TEST USDC on the testnet only; the faucet pays 1,000 per mainnet-funded address. */
export const MAX_SEND_USDC = parseAmount('500');

export interface SendDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly nonceSource?: HyperliquidNonceSource;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Exit codes: 0 sent and seen, 1 the venue refused, the funder is short, or the credit was not seen, 2 refused before anything was sent. */
export type SendExit = 0 | 1 | 2;

class Refusal extends Error {}

/** The send's inputs, checked. Throws `Refusal` naming the one input that is wrong; never echoes the key. */
export function readInputs(env: Readonly<Record<string, string | undefined>>): {
  key: `0x${string}`;
  to: string;
  amount: Amount;
  amountText: string;
} {
  // MetaMask exports a private key as 64 hex characters with no 0x; the secret holds it as pasted.
  const raw = (env.HL_TESTNET_FUNDER_KEY ?? '').trim();
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? `0x${raw}` : raw;
  if (!key) throw new Refusal("HL_TESTNET_FUNDER_KEY is not set: the funded TESTNET account's key (the HL_TESTNET_TRADER_KEY secret).");
  if (!isHexKey(key)) throw new Refusal('HL_TESTNET_FUNDER_KEY is not a 32-byte hex key (its value is not shown).');
  const to = (env.HL_SEND_TO ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Refusal(`HL_SEND_TO must be a 0x address of 40 hex characters (got "${to}").`);
  const amountText = (env.HL_SEND_AMOUNT ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(amountText) || /^0+(\.0+)?$/.test(amountText))
    throw new Refusal(`HL_SEND_AMOUNT must be a positive USDC amount with at most 2 decimals (got "${amountText}").`);
  const amount = parseAmount(amountText);
  if (compare(amount, MAX_SEND_USDC) > 0)
    throw new Refusal(`HL_SEND_AMOUNT ${amountText} is above the cap of ${formatAmount(MAX_SEND_USDC)} TEST USDC per run.`);
  const funder = privateKeyToAccount(key).address.toLowerCase();
  if (to.toLowerCase() === funder) throw new Refusal("HL_SEND_TO is the funder's own address; nothing to send.");
  return { key, to: to.toLowerCase(), amount, amountText };
}

async function info(fetchImpl: FetchLike, baseUrl: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetchImpl(`${baseUrl}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`info ${String(body.type)}: HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

/** Free spot USDC (total minus hold) of `user` on the testnet. */
export async function spotUsdcFree(fetchImpl: FetchLike, baseUrl: string, user: string): Promise<Amount> {
  const state = (await info(fetchImpl, baseUrl, { type: 'spotClearinghouseState', user })) as {
    balances?: { coin?: unknown; total?: unknown; hold?: unknown }[];
  };
  const row = state.balances?.find((b) => b.coin === 'USDC');
  if (!row || typeof row.total !== 'string') return ZERO;
  return sub(parseAmount(row.total), typeof row.hold === 'string' ? parseAmount(row.hold) : ZERO);
}

/** The venue's own name for spot USDC, `USDC:<tokenId>`, from spotMeta. */
async function usdcToken(fetchImpl: FetchLike, baseUrl: string): Promise<string> {
  const meta = (await info(fetchImpl, baseUrl, { type: 'spotMeta' })) as { tokens?: { name?: unknown; tokenId?: unknown }[] };
  const usdc = meta.tokens?.find((t) => t.name === 'USDC');
  if (!usdc || typeof usdc.tokenId !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(usdc.tokenId))
    throw new Error("the venue's spotMeta lists no tokenId for USDC");
  return `USDC:${usdc.tokenId}`;
}

export async function runSend(deps: SendDeps): Promise<SendExit> {
  const { env, out, err } = deps;
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nonceSource = deps.nonceSource ?? new InMemoryNonceSource();

  let baseUrl: string;
  let inputs: ReturnType<typeof readInputs>;
  try {
    baseUrl = assertTestnetUrl(env.HL_API_URL ?? HL_TESTNET_API_URL);
    // The adapter's own refusal: APP_ENV must be exactly dev or test.
    new HyperliquidTestnetUserVenue({ appEnv: env.APP_ENV, baseUrl, fetch: fetchImpl });
    inputs = readInputs(env);
  } catch (error) {
    err(`testnet send refused: ${(error as Error).message}`);
    return 2;
  }
  const signer = privateKeyToAccount(inputs.key);
  const from = signer.address.toLowerCase();
  out(`testnet send on ${baseUrl} (TEST funds only): ${inputs.amountText} USDC ${from} -> ${inputs.to}`);

  let fromBefore: Amount;
  let toBefore: Amount;
  let token: string;
  try {
    fromBefore = await spotUsdcFree(fetchImpl, baseUrl, from);
    toBefore = await spotUsdcFree(fetchImpl, baseUrl, inputs.to);
    token = await usdcToken(fetchImpl, baseUrl);
  } catch (error) {
    err(`testnet send stopped: could not read the venue (${(error as Error).message}); nothing was sent.`);
    return 1;
  }
  out(`before: funder ${formatAmount(fromBefore)} spot USDC free, destination ${formatAmount(toBefore)}`);
  if (compare(fromBefore, inputs.amount) < 0) {
    err(
      `testnet send refused: the funder holds ${formatAmount(fromBefore)} spot USDC free, less than ${inputs.amountText}; nothing was sent.`,
    );
    return 1;
  }

  // A unified account (one balance for spot and perps) refuses `spotSend`, and Hyperliquid's docs do not list which
  // transfer it allows. So each form is tried in turn, moving on only when the venue refuses it for the account mode,
  // and only after reading that the destination has not been credited: a refused form moves nothing.
  const forms: { name: string; build: (n: bigint) => ReturnType<typeof spotSendAction> }[] = [
    { name: 'spotSend', build: (n) => spotSendAction(inputs.to, token, inputs.amountText, n) },
    { name: 'usdSend', build: (n) => usdSendAction(inputs.to, inputs.amountText, n) },
    {
      name: 'sendAsset',
      build: (n) =>
        sendAssetAction(
          { destination: inputs.to, sourceDex: 'spot', destinationDex: 'spot', token, amount: inputs.amountText, fromSubAccount: '' },
          n,
        ),
    },
  ];
  let sent = false;
  for (const form of forms) {
    if (form !== forms[0]) {
      let now: Amount;
      try {
        now = await spotUsdcFree(fetchImpl, baseUrl, inputs.to);
      } catch (error) {
        err(`testnet send stopped: could not re-read the destination (${(error as Error).message}); not trying ${form.name}.`);
        return 1;
      }
      if (compare(now, toBefore) !== 0) {
        err(`testnet send stopped: the destination moved from ${formatAmount(toBefore)} to ${formatAmount(now)}; not trying ${form.name}.`);
        return 1;
      }
    }
    const nonce = await nonceSource.next(from, clock().getTime());
    const { action, typedData } = form.build(BigInt(nonce));
    const signature = await signer.sign({ hash: typedDataDigest(typedData) });
    if ((await recoverTypedDataSigner(typedData, signature)) !== from) {
      err('testnet send stopped: the signature does not recover the funder; not sent.');
      return 1;
    }
    const verdict = await postExchange(
      fetchImpl,
      baseUrl,
      JSON.stringify({ action, nonce: Number(nonce), signature: splitSignature(signature), vaultAddress: null, expiresAfter: null }),
    );
    out(`${form.name} (nonce ${nonce}): ${verdict.text}`);
    if (verdict.ok) {
      sent = true;
      break;
    }
    if (!/unified account/i.test(verdict.text)) return 1;
  }
  if (!sent) return 1;

  const want = add(toBefore, inputs.amount);
  let toAfter = toBefore;
  for (let i = 0; i < 10; i += 1) {
    try {
      toAfter = await spotUsdcFree(fetchImpl, baseUrl, inputs.to);
    } catch {
      // read again below
    }
    if (compare(toAfter, want) >= 0) break;
    await sleep(1_000);
  }
  let fromAfter: string;
  try {
    fromAfter = formatAmount(await spotUsdcFree(fetchImpl, baseUrl, from));
  } catch {
    fromAfter = '?';
  }
  out(`after: funder ${fromAfter} spot USDC free, destination ${formatAmount(toAfter)}`);
  if (compare(toAfter, want) < 0) {
    err(`testnet send: the venue said ok but the destination shows ${formatAmount(toAfter)}, not ${formatAmount(want)}, after 10 reads.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSend({ env: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // A key never reaches an error message: only venue answers and our own words do.
      process.stderr.write(`testnet send stopped: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
