/**
 * Saved desk layouts kept by the account (C-workspace-02, J-charts-desk-07 #3 to #5), read and written through the identity
 * preferences door (`trade.desk.layouts`) with compare-and-set on its version, so a second device shows the same list.
 *
 * - Save names the current desk (its widgets, order and widths) with the symbol and chart interval it is on, and makes it
 *   the layout in use; a name already in the list is replaced only after the person says so.
 * - While a layout is in use, each change to the desk is saved into it (autosave), and a device that opens the desk takes
 *   the layout in use from the account: the account's copy wins.
 * - Copy makes a new layout with its own id; Delete keeps it in the recently deleted list, Restore brings it back. The
 *   owner's limits (how many layouts, how many deleted kept and for how long) are identity's to check; a refusal is shown
 *   with its reason and nothing is changed here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  deskLayoutsPreferenceSchema,
  deskLayoutsRequestId,
  DESK_LAYOUTS_NAMESPACE,
  EMPTY_DESK_LAYOUTS,
  type DeskLayoutsValue,
  type SavedDeskLayout,
} from '@intafaced/contracts/desk-layouts-preferences';
import { useSession } from '../../../features/session/session';
import { CONFLICT, rebaseAndWrite, type RecordIo } from '../../../features/watchlists/rebase';
import type { DeskLayout } from './workspace';

export type { SavedDeskLayout, DeskLayoutsValue };

export type SavedLayouts =
  | { status: 'signed-out' }
  | { status: 'loading' }
  | { status: 'failed'; reload: () => void }
  | { status: 'ready'; value: DeskLayoutsValue };

/** How a write ended: saved, refused by the account with its code, or unknown (the reply was lost; the list was read again). */
export type LayoutWrite = { ok: true } | { ok: false; code: string };

/** An id from the name and the time: lower-case letters, digits and dashes, unique enough for one person's list. */
export function layoutId(name: string, now: Date): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'layout'}-${now.getTime().toString(36)}`.replace(/^-/, '');
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findByName(value: DeskLayoutsValue, name: string): SavedDeskLayout | undefined {
  return value.layouts.find((layout) => sameName(layout.name, name));
}

/** Save the desk as `name`: a new layout, or the one with that name replaced (keeping its id). It becomes the one in use. */
export function saveAs(
  value: DeskLayoutsValue,
  input: { name: string; symbol: string; interval: SavedDeskLayout['interval']; desk: DeskLayout },
  now: Date,
): DeskLayoutsValue {
  const name = input.name.trim();
  const existing = findByName(value, name);
  const layout: SavedDeskLayout = {
    id: existing?.id ?? layoutId(name, now),
    name,
    symbol: input.symbol,
    interval: input.interval,
    desk: deskOf(input.desk),
    savedAt: now.toISOString(),
  };
  const layouts = existing ? value.layouts.map((one) => (one.id === existing.id ? layout : one)) : [...value.layouts, layout];
  return { ...value, layouts, active: layout.id };
}

/** The desk as the record keeps it: plain arrays and widths. */
function deskOf(desk: DeskLayout): SavedDeskLayout['desk'] {
  return { v: 1, preset: desk.preset, order: [...desk.order], widths: { ...desk.widths } };
}

/** Each change to the desk goes into the layout in use. Nothing is in use: nothing changes. */
export function autosave(value: DeskLayoutsValue, desk: DeskLayout, now: Date): DeskLayoutsValue {
  if (value.active === null) return value;
  return {
    ...value,
    layouts: value.layouts.map((layout) =>
      layout.id === value.active ? { ...layout, desk: deskOf(desk), savedAt: now.toISOString() } : layout,
    ),
  };
}

/** A free name: `base`, else `base (2)`, `base (3)` ... */
function freeName(value: DeskLayoutsValue, base: string): string {
  if (!findByName(value, base)) return base;
  for (let n = 2; ; n += 1) if (!findByName(value, `${base} (${n})`)) return `${base} (${n})`;
}

/** A copy with its own id, named "<name> (copy)". */
export function copyLayout(value: DeskLayoutsValue, id: string, now: Date): DeskLayoutsValue {
  const source = value.layouts.find((layout) => layout.id === id);
  if (!source) return value;
  const name = freeName(value, `${source.name} (copy)`).slice(0, 40);
  return { ...value, layouts: [...value.layouts, { ...source, id: layoutId(name, now), name, savedAt: now.toISOString() }] };
}

/** Delete: the layout moves to the recently deleted list, with the time; it is no longer in use. */
export function deleteLayout(value: DeskLayoutsValue, id: string, now: Date): DeskLayoutsValue {
  const layout = value.layouts.find((one) => one.id === id);
  if (!layout) return value;
  return {
    layouts: value.layouts.filter((one) => one.id !== id),
    active: value.active === id ? null : value.active,
    deleted: [...value.deleted.filter((one) => one.id !== id), { ...layout, deletedAt: now.toISOString() }],
  };
}

/** Restore: back in the list, with its own name when that is free, else a free one. */
export function restoreLayout(value: DeskLayoutsValue, id: string): DeskLayoutsValue {
  const deleted = value.deleted.find((one) => one.id === id);
  if (!deleted) return value;
  const { deletedAt: _deletedAt, ...layout } = deleted;
  const name = freeName(value, layout.name).slice(0, 40);
  return { ...value, layouts: [...value.layouts, { ...layout, name }], deleted: value.deleted.filter((one) => one.id !== id) };
}

/** Open: the layout becomes the one in use. */
export function markInUse(value: DeskLayoutsValue, id: string): DeskLayoutsValue {
  return value.layouts.some((layout) => layout.id === id) ? { ...value, active: id } : value;
}

/** The file Export gives: the layout's settings, never any market data. */
export function exportFile(layout: SavedDeskLayout): { name: string; text: string } {
  const safe = layout.name.replace(/[^A-Za-z0-9 ()_-]+/g, '').trim() || 'layout';
  return {
    name: `${safe} desk layout.json`,
    text: `${JSON.stringify({ kind: 'intafaced.desk-layout', v: 1, layout }, null, 2)}\n`,
  };
}

const storedSchema = deskLayoutsPreferenceSchema.extend({ outcome: z.literal('stored') });
const isConflict = (result: { status?: number; code?: string; message: string }) =>
  result.status === 409 || result.code === 'CONFLICT' || result.message.includes(CONFLICT);
const UNKNOWN = 'reply.unknown';

/** The signed-in account's saved desk layouts, and the writes on them. */
export function useSavedLayouts() {
  const { api, userId } = useSession();
  const [layouts, setLayouts] = useState<SavedLayouts>(userId ? { status: 'loading' } : { status: 'signed-out' });
  const [revision, setRevision] = useState(0);
  const record = useRef<{ version: number; value: DeskLayoutsValue } | null>(null);

  const read = useCallback(
    async (signal?: AbortSignal) =>
      api.query('identity', 'preferences.get', { namespace: DESK_LAYOUTS_NAMESPACE }, deskLayoutsPreferenceSchema, { signal }),
    [api],
  );
  const adopt = useCallback((version: number, value: DeskLayoutsValue | null) => {
    record.current = { version, value: value ?? EMPTY_DESK_LAYOUTS };
    setLayouts({ status: 'ready', value: value ?? EMPTY_DESK_LAYOUTS });
  }, []);

  useEffect(() => {
    record.current = null;
    if (!userId) {
      setLayouts({ status: 'signed-out' });
      return;
    }
    const controller = new AbortController();
    setLayouts({ status: 'loading' });
    void read(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) adopt(result.data.version, result.data.value);
      else setLayouts({ status: 'failed', reload: () => setRevision((count) => count + 1) });
    });
    return () => controller.abort();
  }, [userId, read, adopt, revision]);

  const change = useCallback(
    async (update: (value: DeskLayoutsValue) => DeskLayoutsValue): Promise<LayoutWrite> => {
      const start = record.current;
      if (!userId || !start) return { ok: false, code: 'auth.required' };
      const io: RecordIo<DeskLayoutsValue> = {
        read: async () => {
          const result = await read();
          return result.ok ? { version: result.data.version, value: result.data.value } : null;
        },
        write: async (value, ifVersion) => {
          const result = await api.mutate(
            'identity',
            'preferences.set',
            { namespace: DESK_LAYOUTS_NAMESPACE, value, ifVersion, clientRequestId: deskLayoutsRequestId(userId, ifVersion, value) },
            storedSchema,
          );
          if (result.ok) return { ok: true, version: result.data.version, value: result.data.value };
          return {
            ok: false,
            code: isConflict(result)
              ? CONFLICT
              : result.reason === 'uncertain' || result.reason === 'unreachable'
                ? UNKNOWN
                : (result.code ?? result.message),
          };
        },
      };
      const written = await rebaseAndWrite(start, io, update, EMPTY_DESK_LAYOUTS);
      if (written.record) adopt(written.record.version, written.record.value);
      if (written.outcome.ok) return { ok: true };
      if (written.outcome.code === UNKNOWN) {
        const latest = await io.read();
        if (latest) adopt(latest.version, latest.value);
      }
      return { ok: false, code: written.outcome.code };
    },
    [api, userId, read, adopt],
  );

  return { layouts, change };
}
export type SavedLayoutsState = ReturnType<typeof useSavedLayouts>;
