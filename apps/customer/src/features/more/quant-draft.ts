/**
 * The Studio draft, kept on this device until it is saved to the account's library (`features/quant/studio-save.ts`).
 */
import { quantSignalRulesSchema, type QuantSignalRules } from '@intafaced/contracts/quant-algo';

export type DraftBlock = { side: 'buy' | 'sell'; symbol: string; qty: string };
export type StudioDraft = {
  name: string;
  cash: string;
  blocks: DraftBlock[];
  /** Signal rules from the no-code builder; null when the strategy trades by order blocks. */
  modules: QuantSignalRules | null;
  drawdown: string;
  notional: string;
  kill: string;
};
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const MAX_BLOCKS = 50;
const MAX_TEXT = 128;
const keyFor = (ownerId: string | null) => `intafaced.quant.studio-draft.v1:${ownerId ?? 'signed-out'}`;

export const emptyDraft = (): StudioDraft => ({
  name: '',
  cash: '',
  blocks: [{ side: 'buy', symbol: '', qty: '' }],
  modules: null,
  drawdown: '',
  notional: '',
  kill: '',
});

const browserStorage = (): DraftStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.length <= MAX_TEXT ? value : null);

/** Anything that is not exactly a draft is ignored, so a damaged or foreign value can never fill the form. */
export function parseDraft(raw: string | null): StudioDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const name = text(row.name);
    const cash = text(row.cash);
    const drawdown = text(row.drawdown);
    const notional = text(row.notional);
    const kill = text(row.kill);
    if (name === null || cash === null || drawdown === null || notional === null || kill === null) return null;
    if (!Array.isArray(row.blocks) || row.blocks.length === 0 || row.blocks.length > MAX_BLOCKS) return null;
    const blocks: DraftBlock[] = [];
    for (const entry of row.blocks) {
      if (!entry || typeof entry !== 'object') return null;
      const { side, symbol, qty } = entry as Record<string, unknown>;
      if ((side !== 'buy' && side !== 'sell') || text(symbol) === null || text(qty) === null) return null;
      blocks.push({ side, symbol: symbol as string, qty: qty as string });
    }
    // A draft kept before the builder existed has no signal rules; damaged rules are dropped, not guessed.
    const parsedModules = row.modules == null ? null : quantSignalRulesSchema.safeParse(row.modules);
    const modules = parsedModules?.success ? parsedModules.data : null;
    return { name, cash, blocks, modules, drawdown, notional, kill };
  } catch {
    return null;
  }
}

export function readDraft(ownerId: string | null, storage: DraftStorage | null = browserStorage()): StudioDraft | null {
  try {
    return parseDraft(storage?.getItem(keyFor(ownerId)) ?? null);
  } catch {
    return null;
  }
}

/** Returns whether the device kept it. A blank form clears the stored draft instead of storing nothing. */
export function writeDraft(ownerId: string | null, draft: StudioDraft, storage: DraftStorage | null = browserStorage()): boolean {
  try {
    if (!storage) return false;
    const blank = JSON.stringify(draft) === JSON.stringify(emptyDraft());
    if (blank) storage.removeItem(keyFor(ownerId));
    else storage.setItem(keyFor(ownerId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}
