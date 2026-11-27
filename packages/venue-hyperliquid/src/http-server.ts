import http from 'node:http';
import {
  USER_VENUE_READS,
  VenueRefusalError,
  VenueWireError,
  decodeVenueWire,
  encodeVenueWire,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueDepositRoute,
  type VenueSignature,
} from '@intafaced/venue-contracts';
import type { FetchLike, HyperliquidNonceSource, VenueWeightMinute } from './core.js';
import { HL_TESTNET_API_URL } from './signing.js';
import { HyperliquidTestnetUserVenue } from './venue.js';

/**
 * THE HYPERLIQUID TEST NETWORK AS A RUNNING VENUE: `HyperliquidTestnetUserVenue` served over our own HTTP venue protocol,
 * so svc-trade reaches it the way it reaches every venue (services/svc-trade/src/venue/http-user-venue.ts) and no
 * venue code runs inside svc-trade.
 *
 * The routes are the protocol's: `GET /health`, `GET /venue`, `POST /submit {prepared, signature}`, and one `POST` per
 * read in `USER_VENUE_READS` (venue-contracts user-venue-calls.ts), its body each argument under its name. JSON in and
 * out through `encodeVenueWire` (every Amount a decimal string). A `VenueRefusalError` answers 422 `{ refusal }`; a read
 * this adapter does not offer answers 422 `not_offered`; a body that does not parse answers 400; anything else 500.
 *
 * Where the venue's answers come from is the caller's `fetch`: the live test network, or a recording played back
 * (`hl-recorded`, recorded.ts). Proof level `partner-sandbox`: every figure is TEST, and the adapter refuses to run
 * outside APP_ENV dev or test and the beta posture.
 */

/**
 * The chain id `GET /venue` names: the venue's signature chain for user-signed actions (`HL_SIGNATURE_CHAIN_ID` 0x66eee,
 * Arbitrum Sepolia), the network the customer's wallet signs a withdrawal, an agent or a builder-fee approval on.
 */
export const HL_TESTNET_WALLET_CHAIN_ID = 421_614;

export interface UserVenueServerInfo {
  readonly chainId: number;
  readonly deposit: UserVenueDepositRoute | null;
  /** What the venue's answers come from, named on `/health`, and the replay's misses on `GET /replay/misses`. */
  readonly source?: ReplaySource;
  /**
   * Where a person's browser makes their own-wallet reads itself, named on `GET /venue`: the live test network
   * only, never a recording played back. Absent: every read comes through this server.
   */
  readonly walletReads?: VenueWalletReads;
}

/**
 * The venue's public read endpoint, by address with no key, and the perp DEXs it is read on: a desk's own-wallet reads
 * (fills, open orders, balances, positions) go there from the person's own browser, so they count against the person's
 * IP and not this server's one (`HyperliquidWalletReads`, wallet-reads.ts).
 */
export interface VenueWalletReads {
  readonly baseUrl: string;
  readonly perpDexs: readonly string[];
}

/**
 * Where a running venue's answers come from: `hl-recorded` or `hl-testnet`, the recording it answers from
 * or writes (null: none), the trader it was made for (an address), and every request a replay had no answer for.
 */
export interface ReplaySource {
  readonly kind: 'hl-recorded' | 'hl-testnet';
  readonly recording: string | null;
  readonly trader: string | null;
  readonly misses: () => readonly unknown[];
}

type Answer = readonly [number, unknown];

interface ReadRoute {
  readonly name: string;
  readonly args: readonly string[];
}

const READ_BY_PATH: ReadonlyMap<string, ReadRoute> = new Map(
  Object.entries(USER_VENUE_READS).map(([name, spec]): [string, ReadRoute] => [spec.path, { name, args: spec.args }]),
);

/** One request as the server reads it. */
export interface UserVenueRequest {
  readonly method: string;
  readonly path: string;
  readonly rawBody: string;
}

/**
 * An answer as the bytes sent. The wallet's typed data passes the wire encoding untouched, and a user-signed action's
 * uint64 nonce in it is a bigint: it travels as its decimal string, which a wallet signs as the same number.
 */
export function userVenueAnswerJson(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One request's answer, for any `UserVenue`. Exported so a test can drive it without a socket. */
export async function answerUserVenue(
  venue: UserVenue,
  info: UserVenueServerInfo,
  { method, path, rawBody }: UserVenueRequest,
): Promise<Answer> {
  if (method === 'GET' && path === '/health') {
    const source = info.source ? { kind: info.source.kind, recording: info.source.recording, trader: info.source.trader } : null;
    return [200, { ok: true, label: 'TEST', venue: venue.venue.id, chainId: info.chainId, ...(source ? { source } : {}) }];
  }
  if (method === 'GET' && path === '/replay/misses') return [200, { misses: info.source?.misses() ?? [] }];
  if (method === 'GET' && path === '/venue')
    return [
      200,
      {
        label: 'TEST',
        venue: venue.venue,
        chainId: info.chainId,
        deposit: info.deposit,
        ...(info.walletReads ? { walletReads: info.walletReads } : {}),
      },
    ];
  if (method !== 'POST') return [405, { error: 'POST only' }];
  let parsed: unknown;
  try {
    parsed = rawBody.trim() === '' ? {} : JSON.parse(rawBody);
  } catch (err) {
    return [400, { error: messageOf(err) }];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [400, { error: 'the body must be a JSON object' }];
  try {
    if (path === '/submit') {
      const { prepared, signature } = decodeVenueWire<{ prepared: PreparedVenueAction; signature: VenueSignature }>(parsed);
      return [200, encodeVenueWire(await venue.submit(prepared, signature))];
    }
    const body = decodeVenueWire<Record<string, unknown>>(parsed);
    const read = READ_BY_PATH.get(path);
    if (!read) return [404, { error: `no route ${path}` }];
    const fn: unknown = Reflect.get(venue, read.name);
    if (typeof fn !== 'function') {
      throw new VenueRefusalError({
        venueId: venue.venue.id,
        code: 'not_offered',
        detail: `${venue.venue.displayName} does not offer ${read.name}`,
      });
    }
    const value: unknown = await Reflect.apply(
      fn,
      venue,
      read.args.map((name) => body[name]),
    );
    return [200, encodeVenueWire(value)];
  } catch (err) {
    if (err instanceof VenueRefusalError) return [422, { refusal: err.refusal }];
    if (err instanceof VenueWireError) return [400, { error: err.message }];
    return [500, { error: messageOf(err) }];
  }
}

/** An HTTP handler that serves one `UserVenue` (answerUserVenue). */
export function userVenueHandler(venue: UserVenue, info: UserVenueServerInfo): http.RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://venue').pathname;
      answerUserVenue(venue, info, { method: req.method ?? 'GET', path, rawBody: Buffer.concat(chunks).toString('utf8') })
        .then(([status, payload]) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(userVenueAnswerJson(payload));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: messageOf(err) }));
        });
    });
  };
}

export interface StartHyperliquidVenueOptions {
  readonly host: string;
  readonly port: number;
  /** The RAW `process.env.APP_ENV`. */
  readonly appEnv: string | null | undefined;
  /** The RAW `process.env.INTAFACED_BETA_POSTURE`. */
  readonly betaPosture?: string | null;
  /** Where the venue's answers come from: a recording played back (`replayRecording`), or the live test network (omitted). */
  readonly fetch?: FetchLike;
  /** Named on `/health`, with the replay's misses on `GET /replay/misses`. */
  readonly source?: ReplaySource;
  readonly clock?: () => Date;
  readonly nonceSource?: HyperliquidNonceSource;
  readonly timeoutMs?: number;
  /** The HIP-3 perp DEXs listed beside the main one (`HyperliquidTestnetOptions.perpDexs`); none when omitted. */
  readonly perpDexs?: readonly string[];
}

/** Start the Hyperliquid test network venue on loopback. Refuses outside APP_ENV dev/test and the beta posture, and on a non-loopback host. */
export async function startHyperliquidVenueServer(
  opts: StartHyperliquidVenueOptions,
): Promise<{ server: http.Server; venue: HyperliquidTestnetUserVenue; url: string }> {
  if (opts.host !== '127.0.0.1' && opts.host !== '::1' && opts.host !== 'localhost') {
    throw new Error(`the Hyperliquid test network venue listens on loopback only, not ${opts.host}`);
  }
  const venue = new HyperliquidTestnetUserVenue({
    appEnv: opts.appEnv,
    betaPosture: opts.betaPosture ?? null,
    // The wallet signs a user-signed action on the chain `GET /venue` names, so the typed data's domain names that chain too.
    walletChainId: HL_TESTNET_WALLET_CHAIN_ID,
    // Live, every tester's reads leave from this one address, which the venue limits by weight a minute: reads are shared.
    // A recording played back answers every read as recorded, so its reads stay one call each.
    // Live, the weight spent at the venue each minute is one log line, so the limit shows before it refuses.
    ...(opts.fetch
      ? { fetch: opts.fetch }
      : {
          shareReads: true,
          onWeightMinute: (spent: VenueWeightMinute) =>
            process.stdout.write(`${JSON.stringify({ msg: 'hl.venue_weight_minute', limit: 1200, ...spent })}\n`),
        }),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.nonceSource ? { nonceSource: opts.nonceSource } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.perpDexs ? { perpDexs: opts.perpDexs } : {}),
  });
  // The venue names no deposit route: a deposit to it is a bridge transfer on Arbitrum Sepolia, which this adapter
  // does not read yet (`depositRoutes` is not offered), so the app shows none rather than a guessed address.
  const server = http.createServer(
    userVenueHandler(venue, {
      chainId: HL_TESTNET_WALLET_CHAIN_ID,
      deposit: null,
      ...(opts.source ? { source: opts.source } : {}),
      // Live, each person's own-wallet reads leave from their own browser; a replay answers every read itself.
      ...(opts.fetch ? {} : { walletReads: { baseUrl: HL_TESTNET_API_URL, perpDexs: [...(opts.perpDexs ?? [])] } }),
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return { server, venue, url: `http://${opts.host}:${port}` };
}
