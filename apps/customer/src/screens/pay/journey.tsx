import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPersonalPayApi, fmtAmount, useSession, type PersonalPayApi } from './deps';
import { sourcesFrom, type Source } from './send-model';

/** Why a journey cannot run, in plain words, always on screen. */
export function Reason({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pay-reason" role="note" data-testid="pay-reason">
      <p className="pay-reason__title">{title}</p>
      <p className="pay-reason__body">{children}</p>
    </div>
  );
}

/** The steps of a journey, numbered, so a customer can see the whole path before it is connected. */
export function Steps({ items }: { items: readonly string[] }) {
  return (
    <ol className="pay-steps" data-testid="pay-steps">
      {items.map((label) => (
        <li key={label}>{label}</li>
      ))}
    </ol>
  );
}

/** The customer's own balances they could pay from. Real reads; nothing is made up while loading or on a failure. */
export function useSources(): { pay: PersonalPayApi; sources: Source[]; state: 'loading' | 'error' | 'ready' } {
  const { api, userId } = useSession();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const [read, setRead] = useState<{ owner: string | null; list: Source[] | 'error' | null }>({ owner: null, list: null });
  useEffect(() => {
    const controller = new AbortController();
    void pay.spaces(controller.signal).then((result) => {
      if (!controller.signal.aborted) setRead({ owner: userId, list: result.ok ? sourcesFrom(result.data, Date.now()) : 'error' });
    });
    return () => controller.abort();
  }, [pay, userId]);
  const mine = read.owner === userId ? read.list : null;
  return { pay, sources: Array.isArray(mine) ? mine : [], state: mine === null ? 'loading' : mine === 'error' ? 'error' : 'ready' };
}

export const sourceLabel = (row: Source) =>
  `${row.name ? `${row.asset} · ${row.name}` : row.asset} · ${fmtAmount(row.balance, { places: 8, round: 'down' })}`;
