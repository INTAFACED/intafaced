import { quantStrategyHeadSchema, quantStrategyListOutputSchema, type QuantStrategyHead } from '@intafaced/contracts/quant-algo';
import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Panel } from '../../shared/ui';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { HOME_STRATEGY_PAGE } from './AlgoHome';
import { studioCopy } from './studio-copy';

const libraryPage = quantStrategyListOutputSchema.extend({ strategies: z.array(quantStrategyHeadSchema) });

/** The account's saved strategies in Studio: newest version of each, and Open loads its rules into the form. */
export function StudioLibrary({
  revision,
  activeId,
  onOpen,
}: {
  /** Bumped after each save so the list reads again. */
  revision: number;
  activeId: string | null;
  onOpen: (head: QuantStrategyHead) => void;
}) {
  const api = useApi();
  const { t } = studioCopy.useCopy();
  const library = useResource(
    (signal) => api.query('quant', 'studio.list', { limit: HOME_STRATEGY_PAGE }, libraryPage, { signal }),
    `quant-studio-library:${revision}`,
  );
  return (
    <Panel title={t('libraryTitle')}>
      <Read resource={library.resource} retry={library.reload}>
        {(page) =>
          page.strategies.length ? (
            <>
              <DataTable headers={[t('name'), t('versionHeading'), t('actions')]} label={t('libraryTitle')}>
                {page.strategies.map((s) => (
                  <tr key={s.id} aria-current={s.id === activeId ? 'true' : undefined}>
                    <td lang="und">{s.name}</td>
                    <td>{t('version', { version: s.version })}</td>
                    <td>
                      {s.id === activeId ? (
                        <span className="muted">{t('opened')}</span>
                      ) : (
                        <Button variant="secondary" onClick={() => onOpen(s)} aria-label={t('open', { name: s.name })}>
                          {t('open', { name: s.name })}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
              {page.nextCursor && <p className="muted">{t('libraryMore')}</p>}
            </>
          ) : (
            <EmptyState title={t('libraryNone')}>{t('libraryNoneBody')}</EmptyState>
          )
        }
      </Read>
    </Panel>
  );
}
