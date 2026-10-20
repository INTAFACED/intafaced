/**
 * Pure logic of the Positions room: the row an operator sees (what `admin.positions.*` serves), the column layout,
 * status words, and the lookup-form check. Money and sizes are decimal STRINGS. Mark price, liquidation price, margin
 * ratio and PnL are not served by svc-trade's operator read yet: they stay null and draw "—", never zero.
 */

export type PositionStatus = 'open' | 'closing' | 'liquidation_in_progress' | 'liquidated' | 'closed';

export interface PositionRow {
  readonly id: string;
  readonly userId: string;
  /** Market symbol when the markets list has it, otherwise the market id. */
  readonly market: string;
  readonly side: 'long' | 'short';
  readonly size: string;
  readonly entryPrice: string | null;
  readonly markPrice: string | null;
  readonly liquidationPrice: string | null;
  /** Maintenance margin / margin balance, as a decimal string ("0.0825" = 8.25%). */
  readonly marginRatio: string | null;
  readonly unrealisedPnl: string | null;
  /** The service's own status word; unknown words draw as themselves. */
  readonly status: string;
  readonly openedAt: string;
}

export interface PositionsAnswer {
  readonly rows: readonly PositionRow[];
  readonly nextCursor: string | null;
}

/** Map the service rows onto the table, naming each market by symbol where the markets list knows it. */
export function toPositionRows(
  rows: readonly {
    id: string;
    userId: string;
    marketId: string;
    side: 'long' | 'short';
    status: string;
    size: string;
    entryPrice: string;
    openedAt: string;
  }[],
  symbols: ReadonlyMap<string, string>,
): PositionRow[] {
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    market: symbols.get(r.marketId) ?? r.marketId,
    side: r.side,
    size: r.size,
    entryPrice: r.entryPrice,
    markPrice: null,
    liquidationPrice: null,
    marginRatio: null,
    unrealisedPnl: null,
    status: r.status,
    openedAt: r.openedAt,
  }));
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

export function positionStatusWord(s: string): PositionStatusWord {
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
    case 'liquidated':
      return { label: 'Liquidated', tone: 'error', explain: 'The position was liquidated. See the Liquidations room for the rungs.' };
    case 'closed':
      return { label: 'Closed', tone: 'neutral', explain: 'The position is closed.' };
    default:
      return { label: s, tone: 'neutral', explain: 'This desk has no word for this status; it is shown as the service sent it.' };
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
