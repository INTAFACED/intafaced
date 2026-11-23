/**
 * CARD R-quant — paper cannot ledger; live deploy refuse without owner pin.
 *
 * PX-S15 socket.live-strategy-eligibility. Blank pin → no live deployment.
 * Paper / backtest / shadow never post. Pin present still does not launch
 * (no orchestrator). Does not invent Greeks. Does not list a live option.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeServiceBlock } from '@intafaced/config/compose';

export const QUANT_LIVE_DEPLOY_PATH = '/api/v1/quant/live-deploy' as const;
export const QUANT_LIVE_DEPLOY_PIN_ENV = 'TRADE_QUANT_LIVE_DEPLOY_PIN' as const;

export const QUANT_LIVE_DEPLOY_UNPINNED = 'trade.quant_live_deploy_unpinned' as const;
export const QUANT_PAPER_CANNOT_LEDGER = 'trade.quant_paper_cannot_ledger' as const;
export const QUANT_LIVE_DEPLOY_IEEE = 'trade.quant_live_deploy_ieee' as const;

export type QuantLiveDeployRefuseCode =
  typeof QUANT_LIVE_DEPLOY_UNPINNED | typeof QUANT_PAPER_CANNOT_LEDGER | typeof QUANT_LIVE_DEPLOY_IEEE;

export type QuantLiveDeployOk = {
  readonly ok: true;
  readonly preview: true;
  readonly executed: false;
  readonly launched: false;
  readonly posted: false;
  readonly orders: readonly [];
  readonly pinPresent: true;
};

export type QuantLiveDeployRefuse = {
  readonly ok: false;
  readonly code: QuantLiveDeployRefuseCode;
  readonly reason: string;
  readonly executed: false;
  readonly launched: false;
  readonly posted: false;
  readonly orders: readonly [];
};

export type QuantLiveDeployResult = QuantLiveDeployOk | QuantLiveDeployRefuse;

export type QuantLiveDeployInput = {
  readonly pin?: unknown;
  readonly environment?: unknown;
  /** Must never be invoked — paper and live-deploy mill do not post. */
  readonly post?: (recipe: unknown) => Promise<unknown>;
};

const SIMULATED = new Set(['paper', 'backtest', 'shadow']);

function present(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return true;
}

function ieeeOnWire(raw: unknown): boolean {
  return typeof raw === 'number';
}

function environmentOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

export function readOwnerLiveDeployPin(env: NodeJS.ProcessEnv = process.env): unknown {
  return env[QUANT_LIVE_DEPLOY_PIN_ENV];
}

function pickPin(input: unknown, fromEnv: unknown): unknown {
  return present(input) ? input : fromEnv;
}

/**
 * Live strategy deploy admission. Paper cannot ledger. Blank owner pin
 * refuses. IEEE pin refuses. Pin present is preview only — no launch.
 */
export function checkQuantLiveDeploy(input: QuantLiveDeployInput = {}): QuantLiveDeployResult {
  void input.post;

  const environment = environmentOf(input.environment);
  if (SIMULATED.has(environment)) {
    return {
      ok: false,
      code: QUANT_PAPER_CANNOT_LEDGER,
      reason: 'paper/backtest/shadow cannot post to the ledger or launch live',
      executed: false,
      launched: false,
      posted: false,
      orders: [],
    };
  }

  const pinRaw = pickPin(input.pin, readOwnerLiveDeployPin());
  if (ieeeOnWire(pinRaw)) {
    return {
      ok: false,
      code: QUANT_LIVE_DEPLOY_IEEE,
      reason: 'TRADE_QUANT_LIVE_DEPLOY_PIN must be an owner pin string — IEEE number refused on the wire',
      executed: false,
      launched: false,
      posted: false,
      orders: [],
    };
  }
  if (!present(pinRaw) || typeof pinRaw !== 'string') {
    return {
      ok: false,
      code: QUANT_LIVE_DEPLOY_UNPINNED,
      reason: 'TRADE_QUANT_LIVE_DEPLOY_PIN is unset — refuse live deploy rather than launch without eligibility',
      executed: false,
      launched: false,
      posted: false,
      orders: [],
    };
  }

  return {
    ok: true,
    preview: true,
    executed: false,
    launched: false,
    posted: false,
    orders: [],
    pinPresent: true,
  };
}

/** Live deploy door. Refuses or previews; never posts; never launches. */
export async function runQuantLiveDeploy(input: QuantLiveDeployInput = {}): Promise<QuantLiveDeployResult> {
  const check = checkQuantLiveDeploy(input);
  void input.post;
  return check;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export function tradeComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  return composeServiceBlock(compose, 'svc-trade');
}

export function quantLiveDeployPinComposeWired(): boolean {
  const block = tradeComposeBlock();
  return (
    /TRADE_QUANT_LIVE_DEPLOY_PIN:\s*\$\{TRADE_QUANT_LIVE_DEPLOY_PIN:-\}/.test(block) &&
    !/TRADE_QUANT_LIVE_DEPLOY_PIN:\s*\$\{TRADE_QUANT_LIVE_DEPLOY_PIN:-[^}\s]+\}/.test(block)
  );
}
