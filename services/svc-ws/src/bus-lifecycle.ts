import type { HubLogger } from './depth/hub.js';

/**
 * NATS / JetStream lifecycle for the trade tape + private fan-out.
 *
 * Depth keeps serving whether the bus is up or not. When connect/subscribe
 * fails **before any successful attach** (boot or pre-success retries), we
 * retry with exponential backoff instead of leaving `tradesBus` / `privateBus`
 * false until process restart.
 *
 * Ownership split (do not blur these):
 * - **Before first attach:** this loop owns retry + `/ready` flags.
 * - **Tape up, a half still down:** this loop keeps the tape handle and retries
 *   only that half (do not reconnect while the half is merely down). If
 *   `sessionLost` resolves during the retry, close and re-attach — do not
 *   leave the tape reported up.
 * - **After first full attach:** nats.js still owns TCP reconnect on that
 *   socket. If the connection is gone for good, `sessionLost` (nats `closed()`)
 *   drops `/ready` flags and this loop re-attaches — depth keeps serving.
 */

export interface BusLifecycleConnectResult {
  /** Tear down bus + subscriptions on stop or before a retry. */
  readonly close: () => Promise<void>;
  /** Public tape consumer attached. */
  readonly tradesUp: boolean;
  /** Private order (and fill/position) consumers attached. */
  readonly privateUp: boolean;
  /**
   * Independent drop-copy `fillSettled` consumer. Separate durable from the
   * private fills half — omit/`false` until attached.
   */
  readonly dropCopyUp?: boolean;
  /**
   * When the tape is up but private is not, lifecycle calls this on backoff
   * instead of tearing the tape and reconnecting. Return true when all three
   * private consumers are attached. Omit when private is disabled (no JWT).
   */
  readonly retryPrivate?: () => Promise<boolean>;
  /**
   * Retry drop-copy without tearing tape or waiting on the private half.
   * Omit when drop-copy is disabled (no JWT).
   */
  readonly retryDropCopy?: () => Promise<boolean>;
  /**
   * Resolves when this session's NATS connection is gone for good.
   * Omit to park until `stop()` (tests / no closed() hook).
   */
  readonly sessionLost?: Promise<void>;
}

export interface BusLifecycleOptions {
  /** One full connect+subscribe attempt. Throw or return closed state on fail. */
  readonly attempt: () => Promise<BusLifecycleConnectResult>;
  readonly log: HubLogger;
  /** First wait after a failed attempt (ms). */
  readonly initialBackoffMs?: number;
  /** Cap on backoff (ms). */
  readonly maxBackoffMs?: number;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface BusLifecycle {
  /** Non-blocking: first attempt + background retry until up or stopped. */
  start(): void;
  /** Cancel retries and close any live bus handle. */
  stop(): Promise<void>;
  readonly tradesBus: () => boolean;
  readonly privateBus: () => boolean;
  readonly dropCopyBus: () => boolean;
}

const DEFAULT_INITIAL_MS = 1_000;
const DEFAULT_MAX_MS = 60_000;

export function createBusLifecycle(options: BusLifecycleOptions): BusLifecycle {
  const {
    attempt,
    log,
    initialBackoffMs = DEFAULT_INITIAL_MS,
    maxBackoffMs = DEFAULT_MAX_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  let stopped = false;
  let loop: Promise<void> | null = null;
  let handle: BusLifecycleConnectResult | null = null;
  let tradesUp = false;
  let privateUp = false;
  let dropCopyUp = false;

  function apply(result: BusLifecycleConnectResult | null): void {
    handle = result;
    tradesUp = result?.tradesUp === true;
    privateUp = result?.privateUp === true;
    dropCopyUp = result?.dropCopyUp === true;
  }

  function patch(partial: Partial<Pick<BusLifecycleConnectResult, 'tradesUp' | 'privateUp' | 'dropCopyUp'>>): void {
    const base = handle;
    if (!base) return;
    apply({
      close: base.close,
      tradesUp: partial.tradesUp ?? base.tradesUp,
      privateUp: partial.privateUp ?? base.privateUp,
      dropCopyUp: partial.dropCopyUp ?? base.dropCopyUp === true,
      retryPrivate: base.retryPrivate,
      retryDropCopy: base.retryDropCopy,
      sessionLost: base.sessionLost,
    });
  }

  interface HalfRetryWatch {
    readonly gone: () => boolean;
    readonly gonePromise: Promise<void> | null;
  }

  function watchSession(result: BusLifecycleConnectResult): HalfRetryWatch {
    if (!result.sessionLost) return { gone: () => false, gonePromise: null };
    let gone = false;
    let resolveGone: () => void = () => undefined;
    const gonePromise = new Promise<void>((resolve) => {
      resolveGone = resolve;
    });
    void result.sessionLost.then(() => {
      gone = true;
      resolveGone();
    });
    return { gone: () => gone, gonePromise };
  }

  function pauseForRetry(ms: number, watch: HalfRetryWatch): Promise<void> {
    if (!watch.gonePromise) return sleep(ms);
    return Promise.race([sleep(ms), watch.gonePromise]);
  }

  async function retryPrivateHalf(result: BusLifecycleConnectResult, startBackoff: number, watch: HalfRetryWatch): Promise<void> {
    let backoff = startBackoff;
    while (!stopped && !watch.gone()) {
      await pauseForRetry(backoff, watch);
      if (stopped || watch.gone()) return;
      try {
        const up = await result.retryPrivate!();
        if (stopped || watch.gone()) return;
        if (up) {
          patch({ tradesUp: true, privateUp: true });
          log.info({ tradesBus: true, privateBus: true }, 'svc-ws: private bus consumers attached after retry');
          return;
        }
      } catch (err) {
        if (stopped || watch.gone()) return;
        log.warn(
          { err: String(err), backoffMs: backoff },
          'svc-ws: private bus still unavailable — trade tape still attached; retrying private half',
        );
      }
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }

  async function retryDropCopyHalf(result: BusLifecycleConnectResult, startBackoff: number, watch: HalfRetryWatch): Promise<void> {
    let backoff = startBackoff;
    while (!stopped && !watch.gone()) {
      await pauseForRetry(backoff, watch);
      if (stopped || watch.gone()) return;
      try {
        const up = await result.retryDropCopy!();
        if (stopped || watch.gone()) return;
        if (up) {
          patch({ tradesUp: true, dropCopyUp: true });
          log.info({ tradesBus: true, dropCopyBus: true }, 'svc-ws: drop-copy bus consumer attached after retry');
          return;
        }
      } catch (err) {
        if (stopped || watch.gone()) return;
        log.warn(
          { err: String(err), backoffMs: backoff },
          'svc-ws: drop-copy bus still unavailable — trade tape still attached; retrying drop-copy independently of private',
        );
      }
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }

  function halvesSettled(result: BusLifecycleConnectResult): boolean {
    const privateOk = result.privateUp || result.retryPrivate === undefined;
    const dropOk = result.dropCopyUp === true || result.retryDropCopy === undefined;
    return result.tradesUp && privateOk && dropOk;
  }

  function needsHalfRetry(result: BusLifecycleConnectResult): boolean {
    if (!result.tradesUp) return false;
    const needPrivate = result.retryPrivate !== undefined && !result.privateUp;
    const needDrop = result.retryDropCopy !== undefined && result.dropCopyUp !== true;
    return needPrivate || needDrop;
  }

  async function afterAttach(result: BusLifecycleConnectResult, backoffReset: { value: number }): Promise<'lost' | 'done'> {
    if (!result.sessionLost) return 'done';
    await result.sessionLost;
    if (stopped) return 'done';
    log.warn({ tradesBus: false, privateBus: false, dropCopyBus: false }, 'svc-ws: bus session lost — depth still serves; re-attaching');
    await result.close().catch(() => undefined);
    apply(null);
    backoffReset.value = initialBackoffMs;
    return 'lost';
  }

  async function run(): Promise<void> {
    const backoff = { value: initialBackoffMs };
    while (!stopped) {
      try {
        const result = await attempt();
        if (stopped) {
          await result.close().catch(() => undefined);
          apply(null);
          return;
        }
        apply(result);
        if (halvesSettled(result)) {
          log.info(
            { tradesBus: true, privateBus: result.privateUp, dropCopyBus: result.dropCopyUp === true },
            'svc-ws: bus consumers attached',
          );
          if ((await afterAttach(result, backoff)) === 'lost' && !stopped) continue;
          return;
        }
        if (needsHalfRetry(result)) {
          log.info(
            {
              tradesBus: true,
              privateBus: result.privateUp,
              dropCopyBus: result.dropCopyUp === true,
            },
            'svc-ws: bus consumers attached (private and/or drop-copy still retrying)',
          );
          const watch = watchSession(result);
          const retries = Promise.all([
            result.retryPrivate && !result.privateUp ? retryPrivateHalf(result, backoff.value, watch) : Promise.resolve(),
            result.retryDropCopy && result.dropCopyUp !== true ? retryDropCopyHalf(result, backoff.value, watch) : Promise.resolve(),
          ]);
          if (watch.gonePromise) {
            const outcome = await Promise.race([retries.then(() => 'halves' as const), watch.gonePromise.then(() => 'lost' as const)]);
            if (outcome === 'lost') {
              // The old half may never settle. Its watch prevents a late
              // success from patching the replacement session's flags.
              void retries.catch(() => undefined);
              if ((await afterAttach(result, backoff)) === 'lost' && !stopped) continue;
              return;
            }
          }
          await retries;
          if (stopped) return;
          const live = handle ?? result;
          if ((await afterAttach(live, backoff)) === 'lost' && !stopped) continue;
          return;
        }
        if (result.tradesUp || result.privateUp || result.dropCopyUp === true) {
          // Partial without a retry hook (JWT unset) — park, or re-attach on sessionLost.
          log.info(
            { tradesBus: result.tradesUp, privateBus: result.privateUp, dropCopyBus: result.dropCopyUp === true },
            'svc-ws: bus consumers attached',
          );
          if ((await afterAttach(result, backoff)) === 'lost' && !stopped) continue;
          return;
        }
        // Connected but nothing subscribed — treat as fail and retry.
        await result.close().catch(() => undefined);
        apply(null);
      } catch (err) {
        apply(null);
        if (stopped) return;
        log.warn(
          { err: String(err), backoffMs: backoff.value },
          'svc-ws: trade/private bus unavailable — depth still serves; retrying with backoff',
        );
      }
      if (stopped) return;
      await sleep(backoff.value);
      backoff.value = Math.min(backoff.value * 2, maxBackoffMs);
    }
  }

  return {
    start() {
      if (loop) return;
      stopped = false;
      loop = run();
    },
    async stop() {
      stopped = true;
      // Close first so `sessionLost` (nats closed()) unblocks a parked loop.
      if (handle) {
        await handle.close().catch(() => undefined);
        apply(null);
      }
      if (loop) {
        await loop.catch(() => undefined);
        loop = null;
      }
    },
    tradesBus: () => tradesUp,
    privateBus: () => privateUp,
    dropCopyBus: () => dropCopyUp,
  };
}
