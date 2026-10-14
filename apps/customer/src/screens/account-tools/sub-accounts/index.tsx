import { useState } from 'react';
import { Button, StateBlock } from '@intafaced/ui';
import { Plus } from 'lucide-react';
import type { ScreenProps } from '../../../app/screen-types';
import { useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { stamp } from '../../money/time';
import { AccountFrame, ToolsHeading } from '../shared/AccountFrame';
import { ReadFailure } from '../shared/failure';
import { CloseDialog } from './CloseDialog';
import { subAccountsCopy } from './copy';
import { CreateSubAccountDialog } from './CreateSubAccountDialog';
import { readSubAccounts, type SubAccountRow } from './model';

/** Sub-accounts (M9, OKX "Sub-account"): list, create, close. Moving money is drawn as a labelled Preview. */
export default function SubAccountsScreen(_props: ScreenProps) {
  const { t } = subAccountsCopy.useCopy();
  const { api, userId } = useSession();
  const list = useResource((signal) => readSubAccounts(api, signal), `sub-accounts:${userId ?? 'none'}`);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<SubAccountRow | null>(null);

  return (
    <AccountFrame here="sub-accounts">
      <ToolsHeading
        title={t('title')}
        line={t('line')}
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
            {t('create')}
          </Button>
        }
      />

      <section className="tools-card" aria-label={t('table label')}>
        {list.resource.status === 'loading' ? (
          <StateBlock kind="loading" rows={3} rowHeight={48} label={t('loading label')} />
        ) : list.resource.status === 'failed' ? (
          <ReadFailure failure={list.resource.failure} retry={list.reload} title={t('load failed')} retryLabel={t('retry')} />
        ) : list.resource.data.length === 0 ? (
          <StateBlock
            kind="empty"
            title={t('empty title')}
            body={t('empty body')}
            action={{ label: t('create'), onClick: () => setCreating(true) }}
          />
        ) : (
          <>
            <SubAccountTable rows={list.resource.data} onClose={setClosing} />
            <p className="tools-foot">{t('names fixed')}</p>
          </>
        )}
      </section>

      <MovePreview />

      <CreateSubAccountDialog open={creating} onOpenChange={setCreating} onCreated={list.reload} />
      <CloseDialog target={closing} onClose={() => setClosing(null)} onClosed={list.reload} />
    </AccountFrame>
  );
}

function SubAccountTable({ rows, onClose }: { rows: SubAccountRow[]; onClose: (row: SubAccountRow) => void }) {
  const { t } = subAccountsCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <div className="tools-scroll">
      <table className="tools-table">
        <thead>
          <tr>
            <th scope="col">{t('col name')}</th>
            <th scope="col">{t('col purpose')}</th>
            <th scope="col">{t('col created')}</th>
            <th scope="col">{t('col status')}</th>
            <th scope="col" className="tools-table__end">
              <span className="acct-sr">{t('col action')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-revoked={row.revoked || undefined}>
              <th scope="row" className="tools-table__name">
                <span className="tools-ellipsis">{row.label}</span>
              </th>
              <td className="tools-table__wide">{row.purpose ? <span className="tools-ellipsis">{row.purpose}</span> : t('no purpose')}</td>
              <td className="tools-num">{stamp(row.createdAt, timeZone)}</td>
              <td>
                <span className={row.revoked ? 'tools-state tools-state--off' : 'tools-state tools-state--on'}>
                  {row.revoked ? t('Closed') : t('Active')}
                </span>
              </td>
              <td className="tools-table__end">
                {row.revoked ? null : (
                  <Button variant="secondary" size={32} aria-label={t('Close named', { name: row.label })} onClick={() => onClose(row)}>
                    {t('Close')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Moving money between the main account and a sub-account has no customer-facing call yet. This is the shape the
 * confirmation will take, with no amounts in it: every figure is a dash, and the button cannot be pressed.
 */
function MovePreview() {
  const { t } = subAccountsCopy.useCopy();
  return (
    <section className="tools-card tools-preview" aria-labelledby="move-title" data-preview="move-money">
      <header className="tools-preview__head">
        <h2 id="move-title" className="tools-h2">
          {t('move title')}
        </h2>
        <span className="tools-tag tools-tag--lime">{t('move preview')}</span>
      </header>
      <p className="tools-line">{t('move body')}</p>
      <dl className="tools-rows" aria-disabled="true">
        <div>
          <dt>{t('move from')}</dt>
          <dd>{t('move main')}</dd>
        </div>
        <div>
          <dt>{t('move to')}</dt>
          <dd>{t('move none')}</dd>
        </div>
        <div>
          <dt>{t('move amount')}</dt>
          <dd>{t('move none')}</dd>
        </div>
        <div>
          <dt>{t('move fee')}</dt>
          <dd>{t('move none')}</dd>
        </div>
        <div>
          <dt>{t('move total')}</dt>
          <dd>{t('move none')}</dd>
        </div>
      </dl>
      <div>
        <Button variant="secondary" disabled>
          {t('move submit')}
        </Button>
      </div>
    </section>
  );
}
