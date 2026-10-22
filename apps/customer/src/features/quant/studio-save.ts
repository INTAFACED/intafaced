/**
 * Which saved strategy the Studio form is, kept on this device next to the draft. The write keys are derived from it,
 * so a press of Save after a lost reply sends the same key and the service answers with the first result: never a
 * second strategy and never a second version for one press.
 */
export type StudioRules = {
  name: string;
  cash: string;
  blocks: { side: 'buy' | 'sell'; symbol: string; qty: string }[];
  risk: { maxDrawdown: string; maxNotional: string; kill: string };
};
export type StudioLink = {
  /** The draft's own id, made once when the draft starts; the service keeps one strategy per id. */
  clientStrategyId: string;
  strategyId: string | null;
  version: number | null;
  /** The rules as last saved, to tell whether the form has changed since. */
  saved: string | null;
};

const keyFor = (ownerId: string | null) => `intafaced.quant.studio-link.v1:${ownerId ?? 'signed-out'}`;

export const newLink = (clientStrategyId: string = crypto.randomUUID()): StudioLink => ({
  clientStrategyId,
  strategyId: null,
  version: null,
  saved: null,
});

/** The rules in one stable text: two forms with the same rules give the same text. */
export function fingerprint(rules: StudioRules): string {
  return JSON.stringify([
    rules.name.trim(),
    rules.cash.trim(),
    rules.blocks.map((b) => [b.side, b.symbol.trim(), b.qty.trim()]),
    [rules.risk.maxDrawdown.trim(), rules.risk.maxNotional.trim(), rules.risk.kill.trim()],
  ]);
}

/** The first save of a draft is keyed by the draft; each later save by the version it starts from. */
export function saveKey(link: StudioLink): string {
  return link.strategyId && link.version
    ? `studio.update:${link.strategyId}:from-v${link.version}`
    : `studio.save:${link.clientStrategyId}`;
}

export function parseLink(raw: string | null): StudioLink | null {
  if (!raw) return null;
  try {
    const row = JSON.parse(raw) as Record<string, unknown>;
    const id = row.clientStrategyId;
    if (typeof id !== 'string' || !id || id.length > 128) return null;
    const strategyId = typeof row.strategyId === 'string' && row.strategyId ? row.strategyId : null;
    const version = typeof row.version === 'number' && Number.isInteger(row.version) && row.version > 0 ? row.version : null;
    const saved = typeof row.saved === 'string' ? row.saved : null;
    return strategyId && version
      ? { clientStrategyId: id, strategyId, version, saved }
      : { clientStrategyId: id, strategyId: null, version: null, saved: null };
  } catch {
    return null;
  }
}

type LinkStorage = Pick<Storage, 'getItem' | 'setItem'>;
const browserStorage = (): LinkStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function readLink(ownerId: string | null, storage: LinkStorage | null = browserStorage()): StudioLink {
  try {
    return parseLink(storage?.getItem(keyFor(ownerId)) ?? null) ?? newLink();
  } catch {
    return newLink();
  }
}

export function writeLink(ownerId: string | null, link: StudioLink, storage: LinkStorage | null = browserStorage()): void {
  try {
    storage?.setItem(keyFor(ownerId), JSON.stringify(link));
  } catch {
    // A browser that keeps nothing still saves; only the link to the saved row is lost on reload.
  }
}
