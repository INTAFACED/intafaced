/**
 * The Lit glass switch (redesign stage A0): `?look=lit` turns the new look on for this browser, `?look=off` turns it
 * back off. Off by default, so every journey on main sees today's app. It only sets `data-look` on the root element;
 * everything the look changes is scoped to `[data-look='lit']`.
 */
/** Where the choice is remembered; boot.ts reads it too, to set the look before the first paint. */
export const LOOK_KEY = 'intafaced.look';
export type LookId = 'lit';

function stored(): string | null {
  try {
    return localStorage.getItem(LOOK_KEY);
  } catch {
    return null;
  }
}

function store(value: LookId | null): void {
  try {
    if (value) localStorage.setItem(LOOK_KEY, value);
    else localStorage.removeItem(LOOK_KEY);
  } catch {
    // private mode or blocked storage: the switch lasts for this page only
  }
}

/** Reads `?look=` (and remembers it) or the remembered choice. Pure apart from storage, for tests. */
export function resolveLook(search: string): LookId | null {
  const asked = new URLSearchParams(search).get('look');
  if (asked === 'lit') {
    store('lit');
    return 'lit';
  }
  if (asked === 'off') {
    store(null);
    return null;
  }
  return stored() === 'lit' ? 'lit' : null;
}

/**
 * The look's preview switches, for rendering the direction options the owner chooses from (intafaced issue 9188): `?accent=`
 * picks the Lit accent (`blue`, `ember`, `violet`, `emerald`; `?accent=off` forgets it) and `?scheme=light` draws the
 * light values (`?scheme=dark` forgets it). Both are remembered like the look and off by default, so nobody sees light
 * or another accent without asking for it; light stays unshipped (preferences.ts draws dark for every stored theme).
 */
export const ACCENT_KEY = 'intafaced.look.accent';
export const SCHEME_KEY = 'intafaced.look.scheme';
/** Held equal to `accents` in `@intafaced/ui/lit` by look.test.ts. */
export const LOOK_ACCENTS = ['blue', 'ember', 'violet', 'emerald'] as const;
export type LookAccent = (typeof LOOK_ACCENTS)[number];

function remembered<T extends string>(search: string, param: string, key: string, values: readonly T[], off: string): T | null {
  const asked = new URLSearchParams(search).get(param);
  try {
    if (asked !== null && (values as readonly string[]).includes(asked)) {
      localStorage.setItem(key, asked);
      return asked as T;
    }
    if (asked === off) {
      localStorage.removeItem(key);
      return null;
    }
    const kept = localStorage.getItem(key);
    return kept !== null && (values as readonly string[]).includes(kept) ? (kept as T) : null;
  } catch {
    return asked !== null && (values as readonly string[]).includes(asked) ? (asked as T) : null;
  }
}

export function resolveAccent(search: string): LookAccent | null {
  return remembered(search, 'accent', ACCENT_KEY, LOOK_ACCENTS, 'off');
}

/** `light` only when the light preview was asked for on this device; dark otherwise. */
export function resolvePreviewScheme(search: string = typeof location === 'undefined' ? '' : location.search): 'light' | 'dark' {
  return remembered(search, 'scheme', SCHEME_KEY, ['light'] as const, 'dark') ?? 'dark';
}

/** Called once before the first render. */
export function applyLook(root: HTMLElement = document.documentElement, search: string = location.search): LookId | null {
  const look = resolveLook(search);
  if (look) root.dataset.look = look;
  else delete root.dataset.look;
  const accent = resolveAccent(search);
  if (accent) root.dataset.accent = accent;
  else delete root.dataset.accent;
  resolvePreviewScheme(search);
  return look;
}

export function isLook(look: LookId, root: HTMLElement = document.documentElement): boolean {
  return root.dataset.look === look;
}
