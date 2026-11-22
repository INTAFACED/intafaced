import { type QuantTemplateVersion, type QuantTemplateVersionSource } from '@intafaced/contracts/quant-algo';
import { QUANT_TEMPLATE_GET, QUANT_TEMPLATE_LIST } from '@intafaced/contracts/quant-template-procedures';
import { useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { Read, Select } from '../more';
import { useApi } from '../session';
import { STRATEGY_PAGE } from './StrategyTable';
import { templatesCopy } from './templates-copy';
import { KitFailure, KitLoading, KitTable } from './kit-parts';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * First-party starter templates. Use reads the template's newest version and hands it to the form as a new draft: a
 * read, so pressing Use again after a lost reply reads again and still leaves one draft in the form.
 */
export function StudioTemplates({ onUse }: { onUse: (template: QuantTemplateVersion) => boolean }) {
  const api = useApi();
  const { t } = templatesCopy.useCopy();
  const first = useResource((signal) => api.call(QUANT_TEMPLATE_LIST, { limit: STRATEGY_PAGE }, { signal }), 'quant-templates');
  const [later, setLater] = useState<{ rows: QuantTemplateVersion[]; cursor: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ result: Failed; retry: () => void } | null>(null);
  const [used, setUsed] = useState<QuantTemplateVersion | null>(null);
  const [viewing, setViewing] = useState<{ id: string; name: string; versions: QuantTemplateVersionSource[] } | null>(null);
  // The form's guard as of now, not as of the press: edits typed while the read was in flight are still guarded.
  const latestOnUse = useRef(onUse);
  latestOnUse.current = onUse;
  const reload = () => {
    setLater(null);
    first.reload();
  };

  async function use(id: string) {
    if (busy) return;
    setBusy(id);
    setFailure(null);
    const res = await api.call(QUANT_TEMPLATE_GET, { id });
    setBusy(null);
    if (!res.ok) return setFailure({ result: res, retry: () => void use(id) });
    const newest = res.data.versions[0]!;
    if (latestOnUse.current(newest)) setUsed(newest);
  }

  // Every version of one template, newest first, each with its source: read only, nothing here changes the form.
  async function view(id: string, name: string) {
    if (busy) return;
    setBusy(id);
    setFailure(null);
    setViewing(null);
    const res = await api.call(QUANT_TEMPLATE_GET, { id });
    setBusy(null);
    if (!res.ok) return setFailure({ result: res, retry: () => void view(id, name) });
    setViewing({ id, name, versions: res.data.versions });
  }

  async function more(cursor: string) {
    setBusy('more');
    setFailure(null);
    const res = await api.call(QUANT_TEMPLATE_LIST, { limit: STRATEGY_PAGE, cursor });
    setBusy(null);
    if (res.ok) setLater((prev) => ({ rows: [...(prev?.rows ?? []), ...res.data.templates], cursor: res.data.nextCursor }));
    else setFailure({ result: res, retry: () => void more(cursor) });
  }

  return (
    <section className="lt-panel">
      <h2 className="lt-panel-title">{t('title')}</h2>
      <div data-testid="quant-templates">
        <p className="lt-hint">{t('intro')}</p>
        <Read resource={first.resource} retry={reload}>
          {(data) => {
            const rows = [...data.templates, ...(later?.rows ?? [])];
            const cursor = later ? later.cursor : data.nextCursor;
            if (!rows.length) return <EmptyState title={t('none')} body={t('noneBody')} />;
            return (
              <>
                <KitTable headers={[t('name'), t('about'), t('versionHeading'), t('note'), t('actions')]} label={t('title')}>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td lang="und">{row.name}</td>
                      <td lang="und">{row.description}</td>
                      <td>{t('version', { version: row.version })}</td>
                      <td lang="und">{row.releaseNote}</td>
                      <td>
                        <Button tone="secondary" onClick={() => void use(row.id)} disabled={busy !== null}>
                          {t('use', { name: row.name })}
                        </Button>
                        <Button tone="secondary" onClick={() => void view(row.id, row.name)} disabled={busy !== null}>
                          {t('viewSource', { name: row.name })}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </KitTable>
                {cursor && busy === null && (
                  <Button tone="secondary" onClick={() => void more(cursor)}>
                    {t('showMore')}
                  </Button>
                )}
              </>
            );
          }}
        </Read>
        {busy && busy !== 'more' && <KitLoading label={t('using')} />}
        {failure && <KitFailure result={failure.result} retry={failure.retry} />}
        {used && (
          <p role="status" data-testid="quant-template-used">
            {t('used', { name: used.name, version: used.version })}
          </p>
        )}
        {viewing && <TemplateSource key={viewing.id} {...viewing} onClose={() => setViewing(null)} />}
      </div>
    </section>
  );
}

/** One template's versions and the source of the one chosen, read only: Use always takes the newest version. */
function TemplateSource(props: { name: string; versions: QuantTemplateVersionSource[]; onClose: () => void }) {
  const { t } = templatesCopy.useCopy();
  const newest = props.versions[0]!;
  const [chosen, setChosen] = useState(newest.version);
  const shown = props.versions.find((row) => row.version === chosen) ?? newest;
  return (
    <section aria-label={t('sourceTitle', { name: props.name })} data-testid="quant-template-view">
      <h3>{t('sourceTitle', { name: props.name })}</h3>
      <Select
        label={t('versionPick')}
        value={String(shown.version)}
        onChange={(value) => setChosen(Number(value))}
        options={props.versions.map((row) => ({ value: String(row.version), label: t('version', { version: row.version }) }))}
      />
      <p lang="und" data-testid="quant-template-source-note">
        {shown.releaseNote}
      </p>
      <p className="lt-hint">{t('readOnly', { version: newest.version })}</p>
      <pre lang="zxx" className="lt-mono lt-scroll-x" tabIndex={0} data-testid="quant-template-source" data-version={shown.version}>
        {shown.source}
      </pre>
      <Button tone="secondary" onClick={props.onClose}>
        {t('closeSource')}
      </Button>
    </section>
  );
}
