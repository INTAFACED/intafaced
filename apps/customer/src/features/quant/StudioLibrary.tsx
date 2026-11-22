import type { QuantStrategyHead } from '@intafaced/contracts/quant-algo';
import { Button, EmptyState } from '@intafaced/ui/lit';
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
    <section className="lt-panel">
      <h2 className="lt-panel-title">{t('libraryTitle')}</h2>
      <StrategyTable
        label={t('libraryTitle')}
        reloadKey={`studio:${revision}`}
        empty={<EmptyState title={t('libraryNone')} body={t('libraryNoneBody')} />}
        action={(s) =>
          s.id === activeId ? (
            <span className="lt-hint">{t('opened')}</span>
          ) : (
            <Button tone="secondary" onClick={() => onOpen(s)}>
              {t('open', { name: s.name })}
            </Button>
          )
        }
      />
    </section>
  );
}
