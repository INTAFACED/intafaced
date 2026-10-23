import type { QuantStrategyHead } from '@intafaced/contracts/quant-algo';
import { Button, EmptyState, Panel } from '../../shared/ui';
import { StrategyTable } from './StrategyTable';
import { studioCopy } from './studio-copy';

/** The account's saved strategies in Studio; Open loads one into the form. */
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
  const { t } = studioCopy.useCopy();
  return (
    <Panel title={t('libraryTitle')}>
      <StrategyTable
        label={t('libraryTitle')}
        reloadKey={`studio:${revision}`}
        empty={<EmptyState title={t('libraryNone')}>{t('libraryNoneBody')}</EmptyState>}
        action={(s) =>
          s.id === activeId ? (
            <span className="muted">{t('opened')}</span>
          ) : (
            <Button variant="secondary" onClick={() => onOpen(s)}>
              {t('open', { name: s.name })}
            </Button>
          )
        }
      />
    </Panel>
  );
}
