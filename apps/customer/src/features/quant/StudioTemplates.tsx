import { quantTemplateDetailSchema, quantTemplateListOutputSchema, type QuantTemplateVersion } from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { STRATEGY_PAGE } from './StrategyTable';
import { templatesCopy } from './templates-copy';

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

  async function use(id: string) {
    if (busy) return;
    setBusy(id);
    setFailure(null);
    const res = await api.query('quant', 'template.get', { id }, quantTemplateDetailSchema);
    setBusy(null);
    if (!res.ok) return setFailure({ result: res, retry: () => void use(id) });
    const newest = res.data.versions[0]!;
    if (onUse(newest)) setUsed(newest);
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
        <Read resource={first.resource} retry={first.reload}>
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
      </div>
    </Panel>
  );
}
