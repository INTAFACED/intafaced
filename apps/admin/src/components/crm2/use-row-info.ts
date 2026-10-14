'use client';
/**
 * The list response carries a row's stage, owner, amount and next action, but not the questionnaire answers or the source.
 * The Inbox rows need an investor's type, role and timing and their source, or one key answer for everyone else. So the rows
 * that are on screen are read one by one (three at a time) and remembered; a row is read again only when its revision changes.
 * Until a row's answers arrive the row shows its other columns and a quiet placeholder for these.
 */
import { useEffect, useState } from 'react';
import { answersFor, type Answers } from './answers';
import { fetchDetail } from './request';

export type RowInfo = { answers: Answers | null; source: string | null };
const cache = new Map<string, { revision: number; info: RowInfo }>();
const CONCURRENCY = 3;

/** "A", "A · latest B", or null when neither is known. */
export function sourceValue(first: string | null | undefined, latest: string | null | undefined): string | null {
  if (first && latest && first !== latest) return `${first} · latest ${latest}`;
  return first ?? latest ?? null;
}

export function useRowInfo(
  rows: ReadonlyArray<{ id: string; revision: number; audience: string }>,
  enabled: boolean,
): ReadonlyMap<string, RowInfo> {
  const [, setTick] = useState(0);
  const wanted = rows.filter((row) => cache.get(row.id)?.revision !== row.revision);
  const key = enabled ? wanted.map((row) => `${row.id}:${row.revision}:${row.audience}`).join(',') : '';
  useEffect(() => {
    if (!key) return;
    let live = true;
    const queue = key.split(',').map((part) => {
      const [id = '', revision = '0', audience = ''] = part.split(':');
      return { id, revision: Number(revision), audience };
    });
    async function worker() {
      for (let next = queue.shift(); next && live; next = queue.shift()) {
        try {
          const detail = await fetchDetail(next.id);
          if (!live) return;
          if (detail) {
            cache.set(next.id, {
              revision: next.revision,
              info: {
                answers: answersFor(detail.submission, next.audience),
                source: sourceValue(
                  detail.provenance.firstKnownSource?.campaign?.name,
                  detail.provenance.latestKnownSource?.campaign?.name,
                ),
              },
            });
            setTick((value) => value + 1);
          }
        } catch {
          // A row that cannot be read keeps its placeholder; the list itself is unaffected.
        }
      }
    }
    for (let i = 0; i < CONCURRENCY; i += 1) void worker();
    return () => {
      live = false;
    };
  }, [key]);
  return new Map([...cache].map(([id, entry]) => [id, entry.info]));
}
