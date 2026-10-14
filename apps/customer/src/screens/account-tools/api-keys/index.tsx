import { useState } from 'react';
import { Button, StateBlock } from '@intafaced/ui';
import { KeyRound, ShieldOff } from 'lucide-react';
import type { ScreenProps } from '../../../app/screen-types';
import { useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { stamp } from '../../money/time';
import { AccountFrame, ToolsHeading } from '../shared/AccountFrame';
import { ReadFailure } from '../shared/failure';
import { apiKeysCopy } from './copy';
import { CreateKeyDialog } from './CreateKeyDialog';
import { permissionsOf, readKeys, type ApiKeyRow } from './model';
import { RevokeDialog } from './RevokeDialog';

/** API keys (M9, OKX "My API"): your keys, create one with permissions, revoke. The new key is shown once. */
export default function ApiKeysScreen(_props: ScreenProps) {
  const { t } = apiKeysCopy.useCopy();
  const { api, userId } = useSession();
  const keys = useResource((signal) => readKeys(api, signal), `api-keys:${userId ?? 'none'}`);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);

  return (
    <AccountFrame here="api-keys">
      <ToolsHeading
        title={t('title')}
        line={t('line')}
        action={
          <Button onClick={() => setCreating(true)}>
            <KeyRound size={16} strokeWidth={2} aria-hidden="true" />
            {t('create')}
          </Button>
        }
      />
      <aside className="tools-callout tools-callout--quiet">
        <ShieldOff size={20} strokeWidth={1.75} aria-hidden="true" />
        <div>
          <p className="tools-callout__title">{t('withdraw note title')}</p>
          <p>{t('withdraw note body')}</p>
        </div>
      </aside>

      <section className="tools-card" aria-label={t('table label')}>
        {keys.resource.status === 'loading' ? (
          <StateBlock kind="loading" rows={4} rowHeight={48} label={t('loading label')} />
        ) : keys.resource.status === 'failed' ? (
          <ReadFailure failure={keys.resource.failure} retry={keys.reload} title={t('load failed')} retryLabel={t('retry')} />
        ) : keys.resource.data.length === 0 ? (
          <StateBlock
            kind="empty"
            title={t('empty title')}
            body={t('empty body')}
            action={{ label: t('create'), onClick: () => setCreating(true) }}
          />
        ) : (
          <KeyTable rows={keys.resource.data} onRevoke={setRevoking} />
        )}
      </section>

      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={keys.reload} />
      <RevokeDialog target={revoking} onClose={() => setRevoking(null)} onRevoked={keys.reload} />
    </AccountFrame>
  );
}

function KeyTable({ rows, onRevoke }: { rows: ApiKeyRow[]; onRevoke: (row: ApiKeyRow) => void }) {
  const { t } = apiKeysCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <div className="tools-scroll">
      <table className="tools-table">
        <thead>
          <tr>
            <th scope="col">{t('col name')}</th>
            <th scope="col">{t('col key')}</th>
            <th scope="col">{t('col access')}</th>
            <th scope="col">{t('col last used')}</th>
            <th scope="col">{t('col status')}</th>
            <th scope="col" className="tools-table__end">
              <span className="acct-sr">{t('col action')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const access = permissionsOf(row.scopes);
            return (
              <tr key={row.id} data-revoked={row.revoked || undefined}>
                <th scope="row" className="tools-table__name">
                  <span className="tools-ellipsis">{row.name}</span>
                  {row.mode === 'sandbox' ? <span className="tools-tag">{t('Sandbox')}</span> : null}
                </th>
                <td className="tools-mono" aria-label={t('key starts with', { prefix: row.prefix })}>
                  {row.prefix}…
                </td>
                <td>
                  <span className="tools-chips">
                    {access.read ? <span className="tools-chip">{t('Read')}</span> : null}
                    {access.trade ? <span className="tools-chip tools-chip--lime">{t('Trade')}</span> : null}
                    {access.other ? <span className="tools-chip">{t('Other access')}</span> : null}
                    {!access.read && !access.trade && !access.other ? <span className="tools-chip">{t('No access')}</span> : null}
                  </span>
                </td>
                <td className="tools-num">{row.lastUsedAt ? stamp(row.lastUsedAt, timeZone) : t('Never')}</td>
                <td>
                  <span className={row.revoked ? 'tools-state tools-state--off' : 'tools-state tools-state--on'}>
                    {row.revoked ? t('Revoked') : t('Active')}
                  </span>
                </td>
                <td className="tools-table__end">
                  {row.revoked ? null : (
                    <Button
                      variant="secondary"
                      size={32}
                      aria-label={t('Revoke key named', { name: row.name })}
                      onClick={() => onRevoke(row)}
                    >
                      {t('Revoke')}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
