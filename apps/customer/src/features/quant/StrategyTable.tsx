import { quantStrategyHeadSchema, quantStrategyListOutputSchema, type QuantStrategyHead } from '@intafaced/contracts/quant-algo';
import { QUANT_STUDIO_LIST } from '@intafaced/contracts/quant-studio-procedures';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { parsesAs } from '../../shared/api';
import { DataTable } from '../../shared/ui';
import { Read } from '../more';
import { MorePages, useStrategyPages, type StrategyPageRead } from './strategy-pages';
import { studioCopy } from './studio-copy';

export { STRATEGY_PAGE } from './strategy-pages';

const page = quantStrategyListOutputSchema.extend({ strategies: z.array(quantStrategyHeadSchema) });
/** `studio.list` by its record; a row must still read as a head with its rules (amounts as decimals) to be shown. */
const headPage: StrategyPageRead<QuantStrategyHead> = (api, input, signal) =>
  api.call(QUANT_STUDIO_LIST, input, { signal, accept: parsesAs(page) });

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
  const { t } = studioCopy.useCopy();
  const pages = useStrategyPages('studio.list', headPage, reloadKey);
  return (
    <Read resource={pages.first.resource} retry={pages.first.reload}>
      {(data) => {
        const { rows, cursor } = pages.rowsOf(data);
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
            <MorePages cursor={cursor} busy={pages.busy} failure={pages.failure} more={(next) => void pages.more(next)} />
          </>
        );
      }}
    </Read>
  );
}
