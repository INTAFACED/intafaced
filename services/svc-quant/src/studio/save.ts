import type { QuantSignalRules } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { QUANT_CASH_UNSET, QUANT_STUDIO_NOT_FOUND, QUANT_STUDIO_RISK_BLOCK_REQUIRED, QuantError } from '../errors.js';
import { requireSimulatedStamp } from '../honesty.js';
import { compileSignalRules } from './modules.js';
import type { SavedStrategy, StudioBlock, StudioRiskBlock, StudioStore } from './store.js';

export interface StudioSaveInput {
  readonly name: string;
  readonly blocks: readonly StudioBlock[];
  readonly modules?: QuantSignalRules | null;
  readonly risk?: Partial<StudioRiskBlock> | null;
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

function completeRisk(risk: Partial<StudioRiskBlock> | null | undefined): StudioRiskBlock | null {
  if (!risk) return null;
  const maxDrawdown = risk.maxDrawdown?.trim() ?? '';
  const maxNotional = risk.maxNotional?.trim() ?? '';
  const kill = risk.kill?.trim() ?? '';
  if (!maxDrawdown || !maxNotional || !kill) return null;
  return { maxDrawdown, maxNotional, kill };
}

function decimalField(raw: string, field: string): string {
  try {
    parseAmount(raw);
  } catch {
    throw new QuantError('quant.params_invalid', `${field} must be a decimal string`);
  }
  return raw;
}

export function compileStudioSource(blocks: StudioBlock[]): string {
  return blocks.map((block) => `oms.${block.side}(${JSON.stringify(block.symbol)}, ${JSON.stringify(block.qty)});`).join('\n');
}

export function buildSavedStrategy(input: StudioSaveInput, id: string): SavedStrategy {
  const stamp = requireSimulatedStamp(input.environment, input.presentedAs);
  const risk = completeRisk(input.risk ?? null);
  if (!risk) {
    throw new QuantError(
      QUANT_STUDIO_RISK_BLOCK_REQUIRED,
      'studio.save requires a risk block (maxDrawdown / maxNotional / kill as decimal strings)',
    );
  }

  const name = input.name.trim();
  if (!name) throw new QuantError('quant.params_invalid', 'name is required');
  const modules = input.modules ?? null;
  if (modules && input.blocks.length > 0) {
    throw new QuantError('quant.params_invalid', 'a strategy trades by order blocks or by signal rules, not both');
  }
  if (!modules && input.blocks.length < 1) throw new QuantError('quant.params_invalid', 'at least one block is required');

  decimalField(risk.maxDrawdown, 'maxDrawdown');
  decimalField(risk.maxNotional, 'maxNotional');
  decimalField(risk.kill, 'kill');
  const cash = decimalField(requirePaperCash(input.cash), 'cash');

  const blocks: StudioBlock[] = input.blocks.map((block, i) => {
    const symbol = block.symbol.trim();
    if (!symbol) throw new QuantError('quant.params_invalid', `blocks[${i}].symbol is required`);
    const qty = decimalField(block.qty, `blocks[${i}].qty`);
    if (parseAmount(qty) <= 0n) {
      throw new QuantError('quant.params_invalid', `blocks[${i}].qty must be a positive decimal string`);
    }
    return { side: block.side, symbol, qty };
  });
  const compiled = modules ? compileSignalRules(modules) : null;

  return {
    id,
    name,
    language: 'javascript',
    source: compiled ? compiled.source : compileStudioSource(blocks),
    cash,
    blocks,
    modules: compiled ? compiled.rules : null,
    risk,
    ...stamp,
  };
}

export function saveStudio(input: StudioSaveInput, store: StudioStore, accountId: string): SavedStrategy {
  return store.save(accountId, buildSavedStrategy(input, `studio_${crypto.randomUUID()}`));
}

/** Replace one strategy already stored for this account. A missing id is not found. */
export function replaceStudio(input: StudioSaveInput, store: StudioStore, accountId: string, id: string): SavedStrategy {
  if (!store.get(accountId, id)) {
    throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
  }
  const next = buildSavedStrategy(input, id);
  const saved = store.replace(accountId, id, next);
  if (!saved) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
  return saved;
}
