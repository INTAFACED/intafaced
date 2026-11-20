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
 * or another accent without asking for it; light stays unshipped. The scheme lives in preferences.ts, which reads it
 * itself: this file imports nothing, because vite.config.ts loads it through boot.ts.
 */
const ACCENT_KEY = 'intafaced.look.accent';
/** Held equal to `accents` in `@intafaced/ui/lit` by look.test.ts. */
export const LOOK_ACCENTS = ['blue', 'ember', 'violet', 'emerald'] as const;
export type LookAccent = (typeof LOOK_ACCENTS)[number];

const isAccent = (v: string | null): v is LookAccent => v !== null && (LOOK_ACCENTS as readonly string[]).includes(v);

export function resolveAccent(search: string): LookAccent | null {
  const asked = new URLSearchParams(search).get('accent');
  try {
    if (isAccent(asked)) localStorage.setItem(ACCENT_KEY, asked);
    else if (asked === 'off') localStorage.removeItem(ACCENT_KEY);
    else {
      const kept = localStorage.getItem(ACCENT_KEY);
      return isAccent(kept) ? kept : null;
    }
  } catch {
    // private mode or blocked storage: the switch lasts for this page only
  }
  return isAccent(asked) ? asked : null;
}

/**
 * The look directions' preview switch: `?direction=volt` draws a whole direction over the lit look
 * (its own material, type, spark, Home, money object and tab bar), `?direction=off` forgets it. Remembered like the
 * look and off by default; it sets `data-direction` on the root only while the look is on, so nobody sees a direction
 * without asking for it. Everything a direction changes is scoped to `[data-direction='<id>']`.
 */
const DIRECTION_KEY = 'intafaced.look.direction';
/** Held equal to `directions` in `@intafaced/ui/lit` by look.test.ts. */
export const LOOK_DIRECTIONS = ['volt'] as const;
export type LookDirection = (typeof LOOK_DIRECTIONS)[number];

const isDirection = (v: string | null): v is LookDirection => v !== null && (LOOK_DIRECTIONS as readonly string[]).includes(v);

export function resolveDirection(search: string): LookDirection | null {
  const asked = new URLSearchParams(search).get('direction');
  try {
    if (isDirection(asked)) localStorage.setItem(DIRECTION_KEY, asked);
    else if (asked === 'off') localStorage.removeItem(DIRECTION_KEY);
    else {
      const kept = localStorage.getItem(DIRECTION_KEY);
      return isDirection(kept) ? kept : null;
    }
  } catch {
    // private mode or blocked storage: the switch lasts for this page only
  }
  return isDirection(asked) ? asked : null;
}

export function isDirectionOn(direction: LookDirection, root: HTMLElement = document.documentElement): boolean {
  return root.dataset.look !== undefined && root.dataset.direction === direction;
}

/** Called once before the first render. */
export function applyLook(root: HTMLElement = document.documentElement, search: string = location.search): LookId | null {
  const look = resolveLook(search);
  if (look) root.dataset.look = look;
  else delete root.dataset.look;
  const accent = resolveAccent(search);
  if (accent) root.dataset.accent = accent;
  else delete root.dataset.accent;
  const direction = resolveDirection(search);
  if (look && direction) root.dataset.direction = direction;
  else delete root.dataset.direction;
  return look;
}

export function isLook(look: LookId, root: HTMLElement = document.documentElement): boolean {
  return root.dataset.look === look;
}
