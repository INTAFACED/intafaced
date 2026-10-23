import { quantStrategyHeadSchema, quantStrategyListOutputSchema, type QuantStrategyHead } from '@intafaced/contracts/quant-algo';
import { useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Failure, Loading } from '../../shared/ui';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { studioCopy } from './studio-copy';

/** How many saved strategies a list reads at once. A page size of these screens, not a product limit. */
export const STRATEGY_PAGE = 20;

const page = quantStrategyListOutputSchema.extend({ strategies: z.array(quantStrategyHeadSchema) });

/**
 * The account's saved strategies, one page at a time, newest version of each. The Algo dev home and Studio both show
 * it, so paging, refusals and the empty state are written once.
 */
export function StrategyTable({
  label,
  reloadKey,
  empty,
  action,
}: {
  label: string;
  /** Changes when the list must read again, for example after a save. */
  reloadKey: string;
  empty: ReactNode;
  action?: (strategy: QuantStrategyHead) => ReactNode;
}) {
  const api = useApi();
  const { t } = studioCopy.useCopy();
  const first = useResource(
    (signal) => api.query('quant', 'studio.list', { limit: STRATEGY_PAGE }, page, { signal }),
    `quant-strategies:${reloadKey}`,
  );
  const [later, setLater] = useState<{ rows: QuantStrategyHead[]; cursor: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  useEffect(() => {
    setLater(null);
    setFailure(null);
  }, [first.resource]);

  async function more(cursor: string) {
    setBusy(true);
    setFailure(null);
    const res = await api.query('quant', 'studio.list', { limit: STRATEGY_PAGE, cursor }, page);
    setBusy(false);
    if (res.ok) setLater((prev) => ({ rows: [...(prev?.rows ?? []), ...res.data.strategies], cursor: res.data.nextCursor }));
    else setFailure(res);
  }

  return (
    <Read resource={first.resource} retry={first.reload}>
      {(data) => {
        const rows = [...data.strategies, ...(later?.rows ?? [])];
        const cursor = later ? later.cursor : data.nextCursor;
        if (!rows.length) return <>{empty}</>;
        return (
          <>
            <DataTable headers={action ? [t('name'), t('versionHeading'), t('actions')] : [t('name'), t('versionHeading')]} label={label}>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td lang="und">{s.name}</td>
                  <td>{t('version', { version: s.version })}</td>
                  {action && <td>{action(s)}</td>}
                </tr>
              ))}
            </DataTable>
            {busy && <Loading />}
            {failure && <Failure result={failure} retry={() => cursor && void more(cursor)} />}
            {cursor && !busy && (
              <Button variant="secondary" onClick={() => void more(cursor)}>
                {t('showMore')}
              </Button>
            )}
          </>
        );
      }}
    </Read>
  );
}
