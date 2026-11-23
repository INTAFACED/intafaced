import { parseAmount } from '@intafaced/ledger-client/money';
import type { SimulatedPerformanceStamp } from '@intafaced/quant-honesty';
import { QUANT_CASH_UNSET, QUANT_SANDBOX_SYNTAX, QuantError } from '../errors.js';
import { requireSimulatedStamp } from '../honesty.js';
import { createPaperBook, TEST_TICKS, type OrderEvent, type PaperFill, type ReverseLeg } from './book.js';
import { runIsolate, type IsolateLimits, type Language } from './isolate.js';

export interface SandboxRunInput {
  readonly language: Language;
  readonly source: string;
  readonly cash?: string | null;
  readonly environment?: string | null;
  readonly presentedAs?: string | null;
}

function requirePaperCash(cash: string | null | undefined): string {
  if (cash == null || cash.trim() === '') {
    throw new QuantError(QUANT_CASH_UNSET, 'cash is unset — paper bankroll is not invented as 10000');
  }
  return cash;
}

export type SandboxRunResult = SimulatedPerformanceStamp & {
  readonly ok: true;
  readonly language: Language;
  readonly logs: string[];
  readonly cash: string;
  readonly pnl: string;
  readonly fills: PaperFill[];
  readonly positions: { symbol: string; qty: string }[];
  /** Every order's events in the order they happened (AL-orders-01). */
  readonly events: OrderEvent[];
  /** A reversal's legs, each checked on its own (AL-orders-02). */
  readonly legs: ReverseLeg[];
  /** The TEST price path resting limits met after the script, per symbol: a fixture, never a feed. */
  readonly ticks: { label: 'TEST'; path: Record<string, string[]> };
  readonly venue: 'internal';
  readonly venueVault: 'unset' | 'set';
  /**
   * The limits this run met, the same for every language (AL-limits-02; J-algo-dev-16 #1): the plan's wall-clock, memory
   * and output caps and the isolate's operation and source ceilings.
   */
  readonly limits: {
    readonly wallClockMs: number | null;
    readonly memoryBytes: number | null;
    readonly outputBytes: number | null;
    readonly maxOps: number | null;
    readonly maxSource: number | null;
  };
};

export interface SandboxDeps {
  readonly wired: boolean;
  readonly venueVaultSet: boolean;
  readonly limits: IsolateLimits;
  readonly marks?: Readonly<Record<string, string>>;
  /** QUANT_PAPER_FEE_BPS, the paper book's fee in basis points. Blank refuses every order `quant.paper_fee_unset`. */
  readonly paperFeeBps?: string | null;
}

export function runSandbox(input: SandboxRunInput, deps: SandboxDeps): SandboxRunResult {
  const stamp = requireSimulatedStamp(input.environment, input.presentedAs, ['paper', 'shadow']);
  const cash = requirePaperCash(input.cash);
  try {
    parseAmount(cash);
  } catch {
    throw new QuantError(QUANT_SANDBOX_SYNTAX, 'cash must be a decimal string');
  }
  const book = createPaperBook({
    startingCash: cash,
    venueVaultSet: deps.venueVaultSet,
    feeBps: deps.paperFeeBps ?? null,
    ...(deps.marks ? { marks: deps.marks } : {}),
  });
  const ran = runIsolate(input.language, input.source, book, deps.limits, deps.wired);
  return {
    ok: true,
    language: input.language,
    logs: [...ran.logs],
    cash: ran.cash,
    pnl: ran.pnl,
    fills: [...ran.fills],
    positions: [...ran.positions],
    events: [...ran.events],
    legs: [...ran.legs],
    ticks: { label: 'TEST', path: Object.fromEntries(Object.entries(TEST_TICKS).map(([symbol, path]) => [symbol, [...path]])) },
    venue: 'internal',
    venueVault: deps.venueVaultSet ? 'set' : 'unset',
    limits: {
      wallClockMs: deps.limits.run?.wallClockMs ?? null,
      memoryBytes: deps.limits.run?.memoryBytes ?? null,
      outputBytes: deps.limits.run?.outputBytes ?? null,
      maxOps: deps.limits.maxOps ?? null,
      maxSource: deps.limits.maxSource ?? null,
    },
    ...stamp,
  };
}
