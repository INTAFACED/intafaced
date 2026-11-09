/**
 * TESTNET SETUP — run by hand, never in CI. Gets the owner's TESTNET key file ready for `conformance:live`.
 *
 *   APP_ENV=test HL_TESTNET_KEY_FILE=/path/to/keys.json \
 *     pnpm --filter @intafaced/venue-hyperliquid testnet:setup
 *
 * 1. Reads the key file. It must hold `trader`, a 32-byte hex key of a TESTNET wallet; anything else refuses (exit 2)
 *    without showing what the file holds.
 * 2. Adds a fresh throwaway key for each of `agent`, `other` and `third` that is missing, and writes the file back
 *    atomically (a temp file with mode 0600 in the same folder, then a rename). A key already there is never replaced
 *    and its text is kept exactly.
 * 3. Sends `other` and `third` TESTNET USDC from `trader` with the user-signed `usdSend`, only what each is short of
 *    what the conformance suite needs, plus a small cushion. Testnet chain only; mainnet is refused as the adapter
 *    refuses it.
 * 4. Prints each role's address and its testnet USDC (spot and perp) before and after, and what the suite will still
 *    find missing. A key is never printed, logged or written anywhere but the key file.
 */
import { closeSync, fsyncSync, chmodSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { add, compare, formatAmount, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount, UserVenueBalance } from '@intafaced/venue-contracts';
import {
  HL_TESTNET_API_URL,
  HL_TESTNET_VENUE_ID,
  HyperliquidTestnetUserVenue,
  InMemoryNonceSource,
  PERP_COLLATERAL_ASSET,
  assertTestnetUrl,
  recoverTypedDataSigner,
  splitSignature,
  typedDataDigest,
  usdSendAction,
  type FetchLike,
  type HyperliquidNonceSource,
} from '../src/index.js';
import { KEY_NAMES, LIVE_PERP, SUITE_FUNDS, SettingError, ceilTo, isHexKey, resolveSpot, type KeyName } from './live-settings.js';

/**
 * An address the venue has never credited does not exist there, and the venue refuses its actions; any credit
 * creates it. `other` signs orders in the suite even with the perp checks off, so each funded role gets at least this.
 */
export const ACCOUNT_FLOOR_USDC = parseAmount('1');
/** Sent on top of a shortfall, so a fee or rounding on the venue's side does not leave the account just short. */
export const SEND_CUSHION_USDC = parseAmount('1');
const SEND_DECIMALS = 2;

export interface SetupDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly clock?: () => Date;
  readonly nonceSource?: HyperliquidNonceSource;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Exit codes: 0 done, 1 a step failed (venue answer, short of funds), 2 refused before anything was sent. */
export type SetupExit = 0 | 1 | 2;

class Refusal extends Error {}

/**
 * Perp USDC that `other` and `third` each must hold for the suite as the runner runs it: the perp checks' 100000
 * when they run (the suite funds both the same), otherwise only the floor that makes the account exist.
 */
export function usdcNeeded(perp: unknown = LIVE_PERP): Amount {
  const suite = perp === null ? ZERO : SUITE_FUNDS.perpQuote;
  return compare(suite, ACCOUNT_FLOOR_USDC) > 0 ? suite : ACCOUNT_FLOOR_USDC;
}

/** What to send an account holding `have` (perp USDC, free) so it holds `need`: nothing when it already does. */
export function sendFor(have: Amount, need: Amount): Amount {
  if (compare(have, need) >= 0) return ZERO;
  return ceilTo(add(sub(need, have), SEND_CUSHION_USDC), SEND_DECIMALS);
}

function readKeyFile(path: string): { parsed: Record<string, unknown>; keys: Partial<Record<KeyName, `0x${string}`>> } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Refusal('HL_TESTNET_KEY_FILE could not be read.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never echo the file's contents, not even in a parse error.
    throw new Refusal('HL_TESTNET_KEY_FILE is not JSON (its contents are not shown).');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Refusal('HL_TESTNET_KEY_FILE must hold one JSON object (its contents are not shown).');
  }
  const obj = parsed as Record<string, unknown>;
  const keys: Partial<Record<KeyName, `0x${string}`>> = {};
  for (const name of KEY_NAMES) {
    const value = obj[name];
    if (value === undefined) continue;
    if (!isHexKey(value)) throw new Refusal(`key "${name}" is not a 32-byte hex key (its value is not shown).`);
    try {
      privateKeyToAccount(value);
    } catch {
      throw new Refusal(`key "${name}" is not a valid secp256k1 key (its value is not shown).`);
    }
    keys[name] = value;
  }
  if (!keys.trader) throw new Refusal('the key file has no "trader" key.');
  return { parsed: obj, keys };
}

/** Write `text` to `path` atomically: a 0600 temp file in the same folder, flushed, then renamed over it. */
export function writeFileAtomic600(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600); // the umask can only remove bits; this makes 0600 exact
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // already renamed or never made
    }
    throw error;
  }
}

function usdc(balances: readonly UserVenueBalance[], asset: string): Amount {
  return balances.find((b) => b.asset === asset)?.total ?? ZERO;
}
function freeOf(balances: readonly UserVenueBalance[], asset: string): Amount {
  return balances.find((b) => b.asset === asset)?.free ?? ZERO;
}

export async function runSetup(deps: SetupDeps): Promise<SetupExit> {
  const { env, out, err } = deps;
  let venue: HyperliquidTestnetUserVenue;
  let baseUrl: string;
  try {
    // The adapter's own refusals, before the file is touched: APP_ENV must be dev or test, the URL the testnet's.
    baseUrl = assertTestnetUrl(env.HL_API_URL ?? HL_TESTNET_API_URL);
    venue = new HyperliquidTestnetUserVenue({
      appEnv: env.APP_ENV,
      baseUrl,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
  } catch (error) {
    err(`testnet setup refused: ${(error as Error).message}`);
    return 2;
  }
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const clock = deps.clock ?? (() => new Date());
  const nonceSource = deps.nonceSource ?? new InMemoryNonceSource();

  const path = env.HL_TESTNET_KEY_FILE;
  if (!path) {
    err('testnet setup refused: HL_TESTNET_KEY_FILE is not set: give the path of the TESTNET key file.');
    return 2;
  }
  let file: ReturnType<typeof readKeyFile>;
  try {
    file = readKeyFile(path);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    err(`testnet setup refused: ${error.message}`);
    return 2;
  }

  // ── 2. add the missing keys, never replacing one ──
  const keys = { ...file.keys } as Record<KeyName, `0x${string}`>;
  const added: KeyName[] = [];
  for (const name of KEY_NAMES) {
    if (keys[name]) continue;
    keys[name] = generatePrivateKey();
    added.push(name);
  }
  if (added.length > 0) {
    const next: Record<string, unknown> = { ...file.parsed };
    for (const name of added) next[name] = keys[name];
    try {
      writeFileAtomic600(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      err(
        `testnet setup stopped: the key file could not be written (${(error as NodeJS.ErrnoException).code ?? 'error'}); nothing was sent.`,
      );
      return 1;
    }
  }

  const address = Object.fromEntries(KEY_NAMES.map((n) => [n, privateKeyToAccount(keys[n]).address.toLowerCase()])) as Record<
    KeyName,
    string
  >;
  const accountOf = (n: KeyName): UserVenueAccount => ({ venueId: HL_TESTNET_VENUE_ID, owner: address[n], subAccount: null });
  out(`testnet setup on ${baseUrl} (TEST funds only)`);
  out(
    `keys: ${KEY_NAMES.map((n) => `${n} ${added.includes(n) ? 'added' : 'kept'}`).join(', ')}${added.length ? '; file written, mode 600' : '; file unchanged'}`,
  );

  // ── 3. fund other and third from trader ──
  let failed = false;
  const before = new Map<KeyName, readonly UserVenueBalance[]>();
  try {
    for (const n of KEY_NAMES) before.set(n, (await venue.balances(accountOf(n))).value);
  } catch (error) {
    err(`testnet setup stopped: could not read balances (${(error as Error).message}); nothing was sent.`);
    return 1;
  }
  const sends = (['other', 'third'] as const)
    .map((role) => ({ role, amount: sendFor(freeOf(before.get(role)!, PERP_COLLATERAL_ASSET), usdcNeeded()) }))
    .filter((s) => compare(s.amount, ZERO) > 0);
  const total = sends.reduce((acc, s) => add(acc, s.amount), ZERO);
  const traderFree = freeOf(before.get('trader')!, PERP_COLLATERAL_ASSET);
  if (sends.length === 0) out('send: none; other and third already hold what the suite needs');
  else if (compare(traderFree, total) < 0) {
    err(
      `send: refused; trader holds ${formatAmount(traderFree)} perp USDC free, the sends need ${formatAmount(total)}. Top trader up from the testnet faucet.`,
    );
    failed = true;
  } else {
    const traderKey = privateKeyToAccount(keys.trader);
    for (const s of sends) {
      const nonce = await nonceSource.next(address.trader, clock().getTime());
      const { action, typedData } = usdSendAction(address[s.role], formatAmount(s.amount), BigInt(nonce));
      const signature = await traderKey.sign({ hash: typedDataDigest(typedData) });
      if ((await recoverTypedDataSigner(typedData, signature)) !== address.trader) {
        err(`send to ${s.role}: the signature does not recover the trader; not sent.`);
        failed = true;
        continue;
      }
      const verdict = await postExchange(
        fetchImpl,
        baseUrl,
        JSON.stringify({ action, nonce: Number(nonce), signature: splitSignature(signature), vaultAddress: null, expiresAfter: null }),
      );
      out(`send: ${formatAmount(s.amount)} USDC trader -> ${s.role} (nonce ${nonce}): ${verdict.text}`);
      if (!verdict.ok) failed = true;
    }
  }

  // ── 4. the summary ──
  const after = new Map<KeyName, readonly UserVenueBalance[]>();
  try {
    for (const n of KEY_NAMES) after.set(n, (await venue.balances(accountOf(n))).value);
  } catch (error) {
    err(`could not read balances after (${(error as Error).message})`);
    failed = true;
  }
  const cell = (b: readonly UserVenueBalance[] | undefined, asset: string) => (b ? formatAmount(usdc(b, asset)) : '?');
  out('role    address                                     spot USDC before -> after    perp USDC before -> after');
  for (const n of KEY_NAMES) {
    const b = before.get(n);
    const a = after.get(n);
    out(
      `${n.padEnd(7)} ${address[n]}  ${cell(b, 'USDC')} -> ${cell(a, 'USDC')}    ${cell(b, PERP_COLLATERAL_ASSET)} -> ${cell(a, PERP_COLLATERAL_ASSET)}`,
    );
  }

  // What the suite will still find missing; this script cannot supply a spot token or spot USDC.
  const balances = after.size === KEY_NAMES.length ? after : before;
  const traderSpot = freeOf(balances.get('trader')!, 'USDC');
  if (compare(traderSpot, SUITE_FUNDS.traderSpotQuote) < 0) {
    out(
      `still short for the suite: trader holds ${formatAmount(traderSpot)} spot USDC free; its checks fund up to ${formatAmount(SUITE_FUNDS.traderSpotQuote)}`,
    );
  }
  try {
    const spot = await resolveSpot(venue, env);
    const base = freeOf(balances.get('other')!, spot.base);
    out(
      `spot market for the suite: ${spot.symbol.value} (${spot.symbol.source}), price ${formatAmount(spot.price.value)} (${spot.price.source}), size ${formatAmount(spot.size.value)} (${spot.size.source})`,
    );
    if (compare(base, SUITE_FUNDS.otherSpotBase) < 0) {
      out(
        `still short for the suite: other holds ${formatAmount(base)} ${spot.base} free; its checks fund ${formatAmount(SUITE_FUNDS.otherSpotBase)}`,
      );
    }
  } catch (error) {
    out(`spot market for the suite: not resolved (${error instanceof SettingError ? error.message : (error as Error).message})`);
  }
  return failed ? 1 : 0;
}

/** Post a signed action. `ok` only on the venue's own `status: "ok"`; every other answer is shown in the venue's words. */
export async function postExchange(fetchImpl: FetchLike, baseUrl: string, body: string): Promise<{ ok: boolean; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetchImpl(`${baseUrl}/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok)
      return {
        ok: false,
        text: `unknown (HTTP ${res.status}); the balances below show whether it landed, and a re-run sends only what is still short`,
      };
    const answer = JSON.parse(text) as { status?: unknown; response?: unknown };
    if (answer.status === 'ok') return { ok: true, text: 'ok' };
    return {
      ok: false,
      text: `refused by the venue: ${typeof answer.response === 'string' ? answer.response : JSON.stringify(answer.response)}`,
    };
  } catch {
    return {
      ok: false,
      text: 'unknown (no readable answer); the balances below show whether it landed, and a re-run sends only what is still short',
    };
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetup({ env: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // A key never reaches an error message: only venue answers and our own words do.
      process.stderr.write(`testnet setup stopped: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
