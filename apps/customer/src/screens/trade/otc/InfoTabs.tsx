import { roomWords } from '../rooms/refusals';
import { Button, KeyValue } from '../rooms/ui';
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
    <div className="flex max-w-2xl flex-col gap-3">
      <p className="m-0 text-sm text-fg">{t('Export label')}</p>
      <p className="m-0 text-xs text-fg-2">{t('Export columns', { columns: CSV_COLUMNS.join(', ') })}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size={32} disabled={read.length === 0} onClick={() => download(csvFileName(now), buildCsv(read))}>
          {t('Download CSV')}
        </Button>
        <span className="text-sm text-fg-2">{read.length === 0 ? t('Export none') : t('Export count', { count: read.length })}</span>
      </div>
    </div>
  );
}

const REFUSALS = [
  { title: 'Allocation', code: 'trade.rfq_allocation_refused' },
  { title: 'Give-up', code: 'trade.rfq_give_up_refused' },
] as const;

/** Two things the desk does not do yet. No buttons: the service refuses both by name until an owner law names the accounts. */
export function AllocationTab() {
  const { t } = otcCopy.useCopy();
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="m-0 text-sm text-fg-2">{t('Allocation intro')}</p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {REFUSALS.map(({ title, code }) => {
          const words = roomWords({ code });
          return (
            <li key={code} className="rounded-md border border-line bg-panel p-3">
              <h3 className="m-0 text-sm font-medium text-fg">{t(title)}</h3>
              <p className="m-0 mt-1 text-sm text-fg">{words.title}</p>
              <p className="m-0 text-sm text-fg-2">{words.body}</p>
              <p className="m-0 mt-1 text-xs text-fg-2">
                {t('Allocation code')} <span className="font-mono">{words.code}</span>
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
  const items = [
    { label: t('Rule principal'), value: routed ? t('Rule principal routed') : t('Rule principal only') },
    { label: t('Rule fee'), value: t('Rule fee body') },
    { label: t('Rule firm'), value: t('Rule firm body') },
    { label: t('Rule last look'), value: t('Rule last look body') },
    { label: t('Rule settle'), value: t('Rule settle body') },
    { label: t('Rule whole'), value: t('Rule whole body') },
    { label: t('Rule expire'), value: t('Rule expire body') },
  ];
  return <KeyValue layout="stacked" density="dense" items={items} className="max-w-2xl" />;
}
