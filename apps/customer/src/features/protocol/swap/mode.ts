/**
 * The swap form's mode, remembered in this browser only. Simple is the default for a new viewer; Manual shows its notice
 * once. Storage may be absent or blocked: then every visit starts in Simple and the form still works.
 */
export type SwapMode = 'simple' | 'manual';
const MODE_KEY = 'if.dex.swap.mode';
const SEEN_KEY = 'if.dex.swap.manualSeen';

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readMode(): { mode: SwapMode; manualSeen: boolean } {
  try {
    const kept = store();
    const seen = kept?.getItem(SEEN_KEY) === '1';
    return { mode: seen && kept?.getItem(MODE_KEY) === 'manual' ? 'manual' : 'simple', manualSeen: seen };
  } catch {
    return { mode: 'simple', manualSeen: false };
  }
}

export function keepMode(mode: SwapMode, manualSeen: boolean): void {
  try {
    const kept = store();
    kept?.setItem(MODE_KEY, mode);
    if (manualSeen) kept?.setItem(SEEN_KEY, '1');
  } catch {
    /* blocked storage: the choice lasts for this visit only */
  }
}
