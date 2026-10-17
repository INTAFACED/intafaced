/**
 * Opaque keyset cursor for merchant lists.
 *
 * Order is `created_at DESC, id DESC` (payment lines use the same pair ascending).
 * The timestamp is the database's microsecond text, not a JavaScript Date, so two
 * rows in the same millisecond stay in a stable order and a page boundary does
 * not skip or repeat a row. The client treats the cursor as opaque.
 *
 * This module does not throw `PayError` — payment-service owns that type, and
 * importing it here would cycle. Callers map `ListQueryError` onto `PayError`.
 */

const CURSOR_TEXT = /^v1\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export class ListQueryError extends Error {
  constructor(
    readonly code: 'pay.list_cursor_invalid' | 'pay.list_search_invalid' | 'pay.list_asset_invalid' | 'pay.list_range_invalid',
    message: string,
  ) {
    super(message);
  }
}

export interface ListCursor {
  readonly createdAtCursor: string;
  readonly id: string;
}

export interface ListFilters {
  readonly search: string | null;
  readonly assetId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly cursor: ListCursor | null;
}

export function encodeListCursor(createdAtCursor: string, id: string): string {
  return Buffer.from(`v1|${createdAtCursor}|${id.toLowerCase()}`, 'utf8').toString('base64url');
}

export function decodeListCursor(raw: string): ListCursor {
  if (raw.length < 1 || raw.length > 300 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new ListQueryError('pay.list_cursor_invalid', 'List cursor is not valid');
  }
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const match = CURSOR_TEXT.exec(text);
  if (!match) throw new ListQueryError('pay.list_cursor_invalid', 'List cursor is not valid');
  const createdAtCursor = match[1]!;
  const id = match[2]!;
  const parsed = new Date(createdAtCursor);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== createdAtCursor.slice(0, 19)) {
    throw new ListQueryError('pay.list_cursor_invalid', 'List cursor is not valid');
  }
  return { createdAtCursor, id };
}

export function parseListFilters(input: { search?: string; assetId?: string; from?: string; to?: string; cursor?: string }): ListFilters {
  let search: string | null = null;
  if (input.search !== undefined) {
    const trimmed = input.search.trim();
    if (trimmed.length < 1 || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new ListQueryError('pay.list_search_invalid', 'Search must be 1–200 characters with no control characters');
    }
    search = trimmed;
  }
  let assetId: string | null = null;
  if (input.assetId !== undefined) {
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(input.assetId)) {
      throw new ListQueryError('pay.list_asset_invalid', 'Asset filter is not a valid asset code');
    }
    assetId = input.assetId;
  }
  const from = parseBound(input.from, 'from');
  const to = parseBound(input.to, 'to');
  if (from && to && from.getTime() > to.getTime()) {
    throw new ListQueryError('pay.list_range_invalid', 'Date range starts after it ends');
  }
  return { search, assetId, from, to, cursor: input.cursor === undefined ? null : decodeListCursor(input.cursor) };
}

function parseBound(raw: string | undefined, which: 'from' | 'to'): Date | null {
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ListQueryError('pay.list_range_invalid', `Date range ${which} is not a timestamp`);
  }
  return parsed;
}
