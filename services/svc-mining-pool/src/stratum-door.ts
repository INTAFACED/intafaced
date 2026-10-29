import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { Sql } from 'postgres';
import { publishedText, publishedInt, publishedPort, STRATUM_ASSET_PATTERN, WORKER_PATTERN_MAX } from './env.js';
import { MiningError } from './errors.js';
import { requireMinerSecret } from './miner-credential.js';
import { POW_INVALID, POW_SPEC_UNSET, powHeader, publishedPowSpec } from './pow.js';
import { ingestRigShare } from './submit-share.js';
import { DEFAULT_WORKER, WORKER_NAME, WORKER_NAME_INVALID } from './window-store.js';

/**
 * The pool's miner-facing door: a stratum-style line protocol on TCP, the address the mining room tells a rig to use.
 *
 * One JSON object per line, in and out (at most `LINE_MAX` bytes a line).
 * - `{"id":1,"method":"mining.subscribe","params":[]}` answers `{"id":1,"result":[["mining.notify","<session>"]],"error":null}`.
 * - `{"id":2,"method":"mining.authorize","params":["<account id>.<worker name>","<miner secret>"]}` names the account
 *   (the signed-in account's own id, which the room copies), the rig (the worker name the room copies, built from the
 *   published pattern; no worker name is the default worker) and the account's miner secret (issued in the room and
 *   shown once). A missing, unissued or wrong secret is refused `mining.stratum_secret_invalid` before any account
 *   state is touched: the connection writes no share or rejection row and takes no worker lock. It answers `true`,
 *   then the pool sends the job:
 *   `{"id":null,"method":"mining.notify","params":["<job id>","<header hex>",<dimension>,<target bits>,<testnet>]}`.
 *   The header is the pool's own for this window, account and rig; the rig never chooses it.
 * - `{"id":3,"method":"mining.submit","params":["<account id>.<worker name>","<job id>","<nonce>"]}` hands one share to
 *   the same checked ingest the service door uses: the pool checks the work itself and weighs it 1. It answers `true`,
 *   or `"error":{"code":"<typed code>","message":"…"}` (`mining.pow_invalid`, `mining.share_duplicate`,
 *   `mining.job_stale`, …), and a refused share keeps nothing. After `INVALID_SHARES_MAX` shares on one connection fail
 *   the proof-of-work check, the door sends `mining.stratum_invalid_limit` and closes the connection.
 *
 * The door only takes work the pool can check: with no published proof-of-work parameters it refuses `mining.authorize`
 * with `mining.pow_spec_unset`. Only the miner secret's SHA-256 is stored (`miner-credential.ts`). Shares earn no
 * credit while the parameters are testnet (`mining.testnet_no_credit` at payout). The door opens only when its listen
 * port, window length and asset are all published; otherwise it stays closed and says so by `mining.stratum_unset`.
 */

export const STRATUM_UNSET = 'mining.stratum_unset';
export const STRATUM_MALFORMED = 'mining.stratum_malformed';
export const STRATUM_UNAUTHORIZED = 'mining.stratum_unauthorized';
export const STRATUM_METHOD_UNKNOWN = 'mining.stratum_method_unknown';
export const ACCOUNT_INVALID = 'mining.account_invalid';
export const JOB_STALE = 'mining.job_stale';
export const STRATUM_INVALID_LIMIT = 'mining.stratum_invalid_limit';

/** One line of the protocol, in bytes. A longer line closes the connection. */
export const LINE_MAX = 4_096;
/** Lines one connection may have waiting; past this the door stops reading it until they are handled. */
export const PENDING_MAX = 16;
/**
 * Shares one connection may send that fail the proof-of-work check, each one rejection row; at this count the door
 * refuses `mining.stratum_invalid_limit` and closes the connection. A protocol bound like `LINE_MAX`, not an account
 * limit.
 */
export const INVALID_SHARES_MAX = 32;
export const WINDOW_SECONDS_MIN = 60;
export const WINDOW_SECONDS_MAX = 2_678_400;
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type StratumTerms = { readonly port: number; readonly windowSeconds: number; readonly assetId: string };

/** The door's published terms, or `mining.stratum_unset` when any is blank or unusable. Never a default. */
export function readStratumTerms(env: NodeJS.ProcessEnv): StratumTerms {
  const port = publishedPort(env.MINING_STRATUM_LISTEN_PORT);
  const windowSeconds = publishedInt(env.MINING_STRATUM_WINDOW_SECONDS, WINDOW_SECONDS_MIN, WINDOW_SECONDS_MAX);
  const assetId = publishedText(env.MINING_STRATUM_ASSET_ID, 32, false);
  if (port === null || port === 'invalid' || windowSeconds === null || windowSeconds === 'invalid' || assetId === null) {
    throw new MiningError('The miner door is not published', STRATUM_UNSET);
  }
  if (assetId === 'invalid' || !STRATUM_ASSET_PATTERN.test(assetId))
    throw new MiningError('The miner door is not published', STRATUM_UNSET);
  return { port: Number(port), windowSeconds, assetId };
}

/** The window a share made at `nowMs` belongs to: fixed-length windows counted from the Unix epoch, named with their length. */
export function stratumWindowId(windowSeconds: number, nowMs: number): string {
  return `stratum:${windowSeconds}:${Math.floor(nowMs / 1000 / windowSeconds)}`;
}

const DOOR_WINDOW = /^stratum:([1-9]\d{0,7}):(\d{1,12})$/;

/** When a miner-door window ends (ms since the epoch), or null for a window the door did not name. */
export function stratumWindowEndsAt(windowId: string): number | null {
  const match = DOOR_WINDOW.exec(windowId);
  if (!match) return null;
  return (Number(match[2]) + 1) * Number(match[1]) * 1000;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The account and rig a stratum user name names: `<account id>` or `<account id>.<worker name>`. The worker name is the
 * one the room copies: with a published pattern (for example `TEST.{worker}`) it must fit the pattern and the rig is the
 * `{worker}` part; with none it is the rig name itself. No worker name is the default worker.
 */
export function parseRigUser(raw: unknown, env: NodeJS.ProcessEnv): { minerId: string; workerName: string } {
  if (typeof raw !== 'string' || raw.length > 300) throw new MiningError('The account id is not an account', ACCOUNT_INVALID);
  const dot = raw.indexOf('.');
  const minerId = dot === -1 ? raw : raw.slice(0, dot);
  const worker = dot === -1 ? '' : raw.slice(dot + 1);
  if (!ACCOUNT.test(minerId)) throw new MiningError('The account id is not an account', ACCOUNT_INVALID);
  if (dot === -1) return { minerId, workerName: DEFAULT_WORKER };
  const pattern = publishedText(env.MINING_WORKER_NAME_PATTERN, WORKER_PATTERN_MAX, false);
  let name = worker;
  if (typeof pattern === 'string' && pattern.includes('{worker}')) {
    // Every `{worker}` holds the same rig name, as the room fills them all.
    const match = new RegExp(`^${pattern.split('{worker}').map(escapeRegExp).join('(.+)')}$`).exec(worker);
    if (!match || match.slice(2).some((part) => part !== match[1])) {
      throw new MiningError('The worker name does not fit the published pattern', WORKER_NAME_INVALID);
    }
    name = match[1]!;
  }
  if (!WORKER_NAME.test(name)) throw new MiningError('The worker name is not a rig name', WORKER_NAME_INVALID);
  return { minerId, workerName: name };
}

type Rig = { minerId: string; workerName: string; user: string };
type Reply = { id: unknown; result: unknown; error: { code: string; message: string } | null };

export type StratumDoorDeps = {
  readonly sql: Sql;
  readonly env: NodeJS.ProcessEnv;
  readonly terms: StratumTerms;
  /** The clock. Tests pass their own. */
  readonly now?: () => number;
};

function refusal(error: unknown): { code: string; message: string } {
  if (error instanceof MiningError) return { code: error.code, message: error.message };
  const code = error instanceof Error && /^[a-z_]+(\.[a-z_]+)*$/.test(error.message) ? error.message : 'mining.submitShare_failed';
  return { code, message: 'The share was not kept' };
}

/** One rig connection: its own authorized users and their current jobs. `close` ends the connection. */
export function stratumSession(deps: StratumDoorDeps, send: (line: string) => void, close: () => void = () => {}) {
  const now = deps.now ?? Date.now;
  let invalid = 0;
  let closed = false;
  const session = createHash('sha256').update(`${now()}:${Math.random()}`).digest('hex').slice(0, 16);
  const rigs = new Map<string, Rig & { jobId: string }>();

  const reply = (body: Reply) => send(JSON.stringify(body));
  const notify = (rig: Rig) => {
    const spec = publishedPowSpec(deps.env);
    if (!spec) throw new MiningError('Proof-of-work parameters are not published', POW_SPEC_UNSET);
    const jobId = stratumWindowId(deps.terms.windowSeconds, now());
    rigs.set(rig.user, { ...rig, jobId });
    const header = powHeader(jobId, rig.minerId, rig.workerName).toString('hex');
    send(JSON.stringify({ id: null, method: 'mining.notify', params: [jobId, header, spec.dimension, spec.targetBits, spec.testnet] }));
  };

  /** A new job for every rig whose job is no longer the current window's (the pool's answer to a window ending). */
  const renew = () => {
    const current = stratumWindowId(deps.terms.windowSeconds, now());
    for (const rig of rigs.values()) if (rig.jobId !== current) notify(rig);
  };

  const handle = async function handle(line: string): Promise<void> {
    if (closed) return;
    let request: { id: unknown; method: unknown; params: unknown };
    try {
      request = JSON.parse(line) as typeof request;
      if (!request || typeof request !== 'object' || typeof request.method !== 'string' || !Array.isArray(request.params)) {
        throw new Error();
      }
    } catch {
      reply({ id: null, result: null, error: { code: STRATUM_MALFORMED, message: 'One JSON request a line' } });
      return;
    }
    const { id, method } = request;
    const params = request.params as unknown[];
    try {
      if (method === 'mining.subscribe') {
        reply({ id, result: [['mining.notify', session]], error: null });
        return;
      }
      if (method === 'mining.authorize') {
        const rig = parseRigUser(params[0], deps.env);
        await requireMinerSecret(deps.sql, rig.minerId, params[1]);
        if (!publishedPowSpec(deps.env)) throw new MiningError('Proof-of-work parameters are not published', POW_SPEC_UNSET);
        reply({ id, result: true, error: null });
        notify({ ...rig, user: params[0] as string });
        return;
      }
      if (method === 'mining.submit') {
        const rig = typeof params[0] === 'string' ? rigs.get(params[0]) : undefined;
        if (!rig) throw new MiningError('Authorize this worker on this connection first', STRATUM_UNAUTHORIZED);
        const current = stratumWindowId(deps.terms.windowSeconds, now());
        if (params[1] !== rig.jobId || rig.jobId !== current) {
          reply({ id, result: null, error: { code: JOB_STALE, message: 'The job is not the current one' } });
          if (rig.jobId !== current) notify(rig);
          return;
        }
        try {
          await ingestRigShare(deps.sql, deps.env, {
            windowId: rig.jobId,
            assetId: deps.terms.assetId,
            minerId: rig.minerId,
            workerName: rig.workerName,
            powNonce: params[2],
          });
        } catch (error) {
          if (!(error instanceof MiningError && error.code === POW_INVALID)) throw error;
          invalid += 1;
          reply({ id, result: null, error: refusal(error) });
          if (invalid >= INVALID_SHARES_MAX) {
            closed = true;
            reply({ id: null, result: null, error: { code: STRATUM_INVALID_LIMIT, message: 'Too many shares failed the check' } });
            close();
          }
          return;
        }
        reply({ id, result: true, error: null });
        return;
      }
      reply({ id, result: null, error: { code: STRATUM_METHOD_UNKNOWN, message: 'Unknown method' } });
    } catch (error) {
      reply({ id, result: null, error: refusal(error) });
    }
  };
  return Object.assign(handle, { renew });
}

/**
 * The TCP listener. Lines are handled one at a time per connection, in order, and the door stops reading a connection
 * while `PENDING_MAX` of its lines wait. When a window ends, every rig on the connection gets the new window's job.
 */
export function startStratumDoor(deps: StratumDoorDeps, host: string): Server {
  const now = deps.now ?? Date.now;
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    const handle = stratumSession(
      deps,
      (line) => {
        if (!socket.destroyed) socket.write(`${line}\n`);
      },
      () => socket.end(),
    );
    let buffered = '';
    let queue = Promise.resolve();
    let pending = 0;
    let boundary: NodeJS.Timeout | undefined;
    const atNextWindow = () => {
      const windowMs = deps.terms.windowSeconds * 1000;
      boundary = setTimeout(
        () => {
          queue = queue.then(() => {
            try {
              handle.renew();
            } catch {
              // Parameters withdrawn mid-window: the next submit refuses by its own code.
            }
          });
          atNextWindow();
        },
        // A timer holds at most 2^31 - 1 ms; a longer window wakes early, and renew sends nothing until it ends.
        Math.min(windowMs - (now() % windowMs), 2_147_483_647),
      );
      boundary.unref();
    };
    atNextWindow();
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let at = buffered.indexOf('\n');
      while (at !== -1) {
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        if (Buffer.byteLength(line) > LINE_MAX) {
          socket.destroy();
          return;
        }
        if (line) {
          pending += 1;
          if (pending >= PENDING_MAX) socket.pause();
          queue = queue
            .then(() => handle(line))
            .then(() => {
              pending -= 1;
              if (pending < PENDING_MAX && !socket.destroyed) socket.resume();
            });
        }
        at = buffered.indexOf('\n');
      }
      if (Buffer.byteLength(buffered) > LINE_MAX) socket.destroy();
    });
    socket.on('close', () => clearTimeout(boundary));
    socket.on('error', () => socket.destroy());
  });
  server.listen(deps.terms.port, host);
  return server;
}
