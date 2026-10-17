/**
 * Pure logic of the Positions room: the typed row an operator will see once svc-trade lets operators read other
 * users' positions, the column layout, status words, and the lookup-form check. No rows are invented: until the
 * service exists the only rows are an empty list. Money and sizes are decimal STRINGS; unknown is null and draws "—".
 */

export type PositionStatus = 'open' | 'closing' | 'liquidation_in_progress' | 'closed';

export interface PositionRow {
  readonly id: string;
  readonly userId: string;
  readonly market: string;
  readonly side: 'long' | 'short';
  readonly size: string;
  readonly entryPrice: string | null;
  readonly markPrice: string | null;
  readonly liquidationPrice: string | null;
  /** Maintenance margin / margin balance, as a decimal string ("0.0825" = 8.25%). */
  readonly marginRatio: string | null;
  readonly unrealisedPnl: string | null;
  readonly status: PositionStatus;
}

export const POSITION_COLUMNS = [
  { id: 'market', label: 'Market', numeric: false },
  { id: 'side', label: 'Side', numeric: false },
  { id: 'size', label: 'Size', numeric: true },
  { id: 'entry', label: 'Entry price', numeric: true },
  { id: 'mark', label: 'Mark price', numeric: true },
  { id: 'liq', label: 'Liquidation price', numeric: true },
  { id: 'margin', label: 'Margin ratio', numeric: true },
  { id: 'pnl', label: 'Unrealised PnL', numeric: true },
  { id: 'status', label: 'Status', numeric: false },
] as const;

export interface PositionStatusWord {
  readonly label: string;
  readonly tone: 'neutral' | 'lime' | 'warn' | 'error';
  readonly explain: string;
}

export function positionStatusWord(s: PositionStatus): PositionStatusWord {
  switch (s) {
    case 'open':
      return { label: 'Open', tone: 'lime', explain: 'The position is open and margined.' };
    case 'closing':
      return { label: 'Closing', tone: 'warn', explain: 'A close is in progress; the size may change before it ends.' };
    case 'liquidation_in_progress':
      return {
        label: 'Liquidation in progress',
        tone: 'error',
        explain: 'The engine is liquidating this position now. Insurance fund and auto-deleveraging rules apply.',
      };
    case 'closed':
      return { label: 'Closed', tone: 'neutral', explain: 'The position is closed.' };
  }
}

export interface PositionLookup {
  readonly userId: string;
  readonly positionId: string;
}

export type LookupCheck =
  | { readonly ok: true; readonly value: { userId?: string; positionId?: string } }
  | { readonly ok: false; readonly code: string; readonly message: string };

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** At least one of user id or position id; each is a plain token. Bad input is refused with a code, never sent. */
export function checkLookup(input: { userId?: unknown; positionId?: unknown }): LookupCheck {
  const clean = (v: unknown): string | undefined | null => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? undefined : t;
  };
  const userId = clean(input.userId);
  const positionId = clean(input.positionId);
  if (userId === null || positionId === null)
    return { ok: false, code: 'trade_ops.positions_bad_input', message: 'User id and position id must be text.' };
  if (userId === undefined && positionId === undefined)
    return { ok: false, code: 'trade_ops.positions_lookup_empty', message: 'Enter a user id, a position id, or both.' };
  if ((userId !== undefined && !TOKEN.test(userId)) || (positionId !== undefined && !TOKEN.test(positionId)))
    return { ok: false, code: 'trade_ops.positions_bad_input', message: 'Ids use letters, digits and - _ . : only, up to 128 characters.' };
  return { ok: true, value: { ...(userId !== undefined ? { userId } : {}), ...(positionId !== undefined ? { positionId } : {}) } };
}

/** "0.0825" -> "8.25%" without floats: shift the decimal point two places by string work. Unknown stays null. */
export function marginRatioText(ratio: string | null): string | null {
  if (ratio === null || !/^\d+(\.\d+)?$/.test(ratio)) return null;
  const [int = '0', frac = ''] = ratio.split('.');
  const f = frac.padEnd(2, '0');
  const whole = `${int}${f.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = f.slice(2).replace(/0+$/, '');
  return `${whole}${rest ? `.${rest}` : ''}%`;
}
