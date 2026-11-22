import { Button } from '@intafaced/ui/lit';
import { KeyValue } from '@intafaced/ui/lit/templates';
import { roomWords } from '../rooms/refusals';
import { buildCsv, CSV_COLUMNS, csvFileName, type ReadQuote } from './model';
import { otcCopy } from './copy';

/** Save text as a file without a server: the browser builds it from what it has already read. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function ExportTab({ read, now }: { read: readonly ReadQuote[]; now: number }) {
  const { t } = otcCopy.useCopy();
  return (
    <div className="lt-stack">
      <p className="lt-text">{t('Export label')}</p>
      <p className="lt-hint">{t('Export columns', { columns: CSV_COLUMNS.join(', ') })}</p>
      <div className="lt-toolbar">
        <Button disabled={read.length === 0} onClick={() => download(csvFileName(now), buildCsv(read))}>
          {t('Download CSV')}
        </Button>
        <span className="lt-hint">{read.length === 0 ? t('Export none') : t('Export count', { count: read.length })}</span>
      </div>
    </div>
  );
}

const REFUSALS = [
  { title: 'Allocation', code: 'trade.rfq_allocation_refused' },
  { title: 'Give-up', code: 'trade.rfq_give_up_refused' },
] as const;

/** Two things the desk does not do. No buttons: the service refuses both by name until an owner law names the accounts. */
export function AllocationTab() {
  const { t } = otcCopy.useCopy();
  return (
    <div className="lt-stack">
      <p className="lt-hint">{t('Allocation intro')}</p>
      <ul className="lt-list">
        {REFUSALS.map(({ title, code }) => {
          const words = roomWords({ code });
          return (
            <li key={code} className="lt-refusal">
              <h3 className="lt-refusal-title">{t(title)}</h3>
              <p className="lt-text">{words.title}</p>
              <p className="lt-refusal-body">{words.body}</p>
              <p className="lt-hint">
                {t('Allocation code')} <span className="lt-mono">{words.code}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function RulesTab({ routed }: { routed: boolean }) {
  const { t } = otcCopy.useCopy();
  const rows = [
    { label: t('Rule principal'), value: routed ? t('Rule principal routed') : t('Rule principal only') },
    { label: t('Rule fee'), value: t('Rule fee body') },
    { label: t('Rule firm'), value: t('Rule firm body') },
    { label: t('Rule last look'), value: t('Rule last look body') },
    { label: t('Rule settle'), value: t('Rule settle body') },
    { label: t('Rule whole'), value: t('Rule whole body') },
    { label: t('Rule expire'), value: t('Rule expire body') },
  ];
  return <KeyValue rows={rows} />;
}
