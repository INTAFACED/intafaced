import {
  quantTemplateDetailSchema,
  quantTemplateListOutputSchema,
  type QuantTemplateVersion,
  type QuantTemplateVersionSource,
} from '@intafaced/contracts/quant-algo';
import { useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { Read, Select } from '../more/common';
import { useApi } from '../session/session';
import { STRATEGY_PAGE } from './StrategyTable';
import { templatesCopy } from './templates-copy';
import './algo.css';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * First-party starter templates. Use reads the template's newest version and hands it to the form as a new draft: a
 * read, so pressing Use again after a lost reply reads again and still leaves one draft in the form.
 */
export function StudioTemplates({ onUse }: { onUse: (template: QuantTemplateVersion) => boolean }) {
  const api = useApi();
  const { t } = templatesCopy.useCopy();
  const first = useResource(
    (signal) => api.query('quant', 'template.list', { limit: STRATEGY_PAGE }, quantTemplateListOutputSchema, { signal }),
    'quant-templates',
  );
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
    const res = await api.query('quant', 'template.get', { id }, quantTemplateDetailSchema);
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
    const res = await api.query('quant', 'template.get', { id }, quantTemplateDetailSchema);
    setBusy(null);
    if (!res.ok) return setFailure({ result: res, retry: () => void view(id, name) });
    setViewing({ id, name, versions: res.data.versions });
  }

  async function more(cursor: string) {
    setBusy('more');
    setFailure(null);
    const res = await api.query('quant', 'template.list', { limit: STRATEGY_PAGE, cursor }, quantTemplateListOutputSchema);
    setBusy(null);
    if (res.ok) setLater((prev) => ({ rows: [...(prev?.rows ?? []), ...res.data.templates], cursor: res.data.nextCursor }));
    else setFailure({ result: res, retry: () => void more(cursor) });
  }

  return (
    <Panel title={t('title')}>
      <div data-testid="quant-templates">
        <p className="muted">{t('intro')}</p>
        <Read resource={first.resource} retry={reload}>
          {(data) => {
            const rows = [...data.templates, ...(later?.rows ?? [])];
            const cursor = later ? later.cursor : data.nextCursor;
            if (!rows.length) return <EmptyState title={t('none')}>{t('noneBody')}</EmptyState>;
            return (
              <>
                <DataTable headers={[t('name'), t('about'), t('versionHeading'), t('note'), t('actions')]} label={t('title')}>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td lang="und">{row.name}</td>
                      <td lang="und">{row.description}</td>
                      <td>{t('version', { version: row.version })}</td>
                      <td lang="und">{row.releaseNote}</td>
                      <td>
                        <Button variant="secondary" onClick={() => void use(row.id)} disabled={busy !== null}>
                          {t('use', { name: row.name })}
                        </Button>
                        <Button variant="secondary" onClick={() => void view(row.id, row.name)} disabled={busy !== null}>
                          {t('viewSource', { name: row.name })}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
                {cursor && busy === null && (
                  <Button variant="secondary" onClick={() => void more(cursor)}>
                    {t('showMore')}
                  </Button>
                )}
              </>
            );
          }}
        </Read>
        {busy && busy !== 'more' && <Loading label={t('using')} />}
        {failure && <Failure result={failure.result} retry={failure.retry} />}
        {used && (
          <p role="status" data-testid="quant-template-used">
            {t('used', { name: used.name, version: used.version })}
          </p>
        )}
        {viewing && <TemplateSource key={viewing.id} {...viewing} onClose={() => setViewing(null)} />}
      </div>
    </Panel>
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
      <p className="muted">{t('readOnly', { version: newest.version })}</p>
      <pre lang="zxx" className="quant-source" tabIndex={0} data-testid="quant-template-source" data-version={shown.version}>
        {shown.source}
      </pre>
      <Button variant="secondary" onClick={props.onClose}>
        {t('closeSource')}
      </Button>
    </section>
  );
}
