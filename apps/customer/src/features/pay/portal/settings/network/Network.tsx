import { useState } from 'react';
import { EmptyState, Field } from '../../../ui-kit';
import { useResource, type Resource } from '../../../../../shared/resource';
import { PaySection } from '../../../components';
import { useMerchantAccess } from '../../access/MerchantAccess';
import { Chip } from '../../components';
import type { PortalApi } from '../../api';
import { DateTime } from '../../ui/DateTime';
import { EntityList } from '../../ui/EntityList';
import { PortalReview } from '../../ui/PortalReview';
import { useUnsavedForm } from '../../useUnsavedForm';
import { reason as notLive } from '../../chrome/copy';
import { accountCopy } from '../account/copy';
import { portalCopy } from '../copy';
import { bpsPercent, isPlatformAccount, nodeName, parsePercentToBps } from '../account/model';
import type { SubMerchant } from '../account/schemas';
import { ReadGate } from '../account/ui';

/** Platform accounts only. Anyone else who opens the address is told what this page is, not shown a refusal. */
export function NotPlatform() {
  const { t } = accountCopy.useCopy();
  return (
    <EmptyState
      title={t('netNotPlatformTitle')}
      action={
        <a className="text-link" href="/pay/merchant">
          {t('backOverview')}
        </a>
      }
    >
      {t('netNotPlatformBody')}
    </EmptyState>
  );
}

/** `/pay/network`: the businesses under this platform account, and a way to add one. */
export function Network({ portal, merchantId, mode }: { portal: PortalApi; merchantId: string; mode: string | null }) {
  const { canOwnerWrite } = useMerchantAccess();
  const subs = useResource((s) => portal.subList(merchantId, s), `portal:subs:${merchantId}`);
  if (!isPlatformAccount(mode)) return <NotPlatform />;
  return <NetworkView portal={portal} merchantId={merchantId} subs={subs.resource} reload={subs.reload} mayCreate={canOwnerWrite} />;
}

export function NetworkView({
  portal,
  merchantId,
  subs,
  reload,
  mayCreate,
}: {
  portal: PortalApi;
  merchantId: string;
  subs: Resource<SubMerchant[]>;
  reload: () => void;
  mayCreate: boolean;
}) {
  const { t } = accountCopy.useCopy();
  const { t: p } = portalCopy.useCopy();
  return (
    <div className="stack">
      <PaySection title={t('netListTitle')} description={t('netListBody')}>
        <ReadGate
          resource={subs}
          retry={reload}
          waiting={{ reason: notLive('reasonNetwork'), body: t('netWaitBody'), needs: 'submerchant.list' }}
        >
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title={t('netEmptyTitle')}>{t('netEmptyBody')}</EmptyState>
            ) : (
              <EntityList
                label={t('netListTitle')}
                rows={rows}
                rowKey={(r) => r.id}
                href={(r) => `/pay/network/${encodeURIComponent(r.id)}`}
                columns={[
                  { header: t('colSub'), cell: (r) => <strong>{nodeName(r, t('subWord'))}</strong> },
                  { header: p('colStatus'), cell: (r) => <Chip kind="merchant" value={r.status} /> },
                  { header: t('fVerification'), cell: (r) => <Chip kind="kyb" value={r.kybStatus} /> },
                  { header: t('colFee'), cell: (r) => (r.feeBps === null ? t('notSet') : bpsPercent(r.feeBps)) },
                  { header: t('colAdded'), cell: (r) => <DateTime value={r.createdAt} /> },
                ]}
                card={(r) => ({
                  title: nodeName(r, t('subWord')),
                  time: <DateTime value={r.createdAt} />,
                  amount: r.feeBps === null ? t('notSet') : bpsPercent(r.feeBps),
                  status: <Chip kind="merchant" value={r.status} />,
                })}
              />
            )
          }
        </ReadGate>
      </PaySection>
      <CreateSub portal={portal} merchantId={merchantId} allowed={mayCreate} done={reload} />
    </div>
  );
}

function CreateSub({ portal, merchantId, allowed, done }: { portal: PortalApi; merchantId: string; allowed: boolean; done: () => void }) {
  const { t } = accountCopy.useCopy();
  const [userId, setUserId] = useState('');
  const [fee, setFee] = useState('');
  const bps = fee.trim() === '' ? null : parsePercentToBps(fee);
  const feeProblem = fee.trim() !== '' && bps === null;
  useUnsavedForm(Boolean(userId || fee), t('acUnsaved'));
  const why = !allowed ? t('netOwnerOnly') : userId.trim() === '' ? t('netNeedUser') : bps === null ? t('netNeedFee') : undefined;
  return (
    <PaySection title={t('netCreateTitle')} description={t('netCreateBody')}>
      <div data-testid="form-stack" className="form-stack pp-form">
        <Field
          label={`${t('netUserLabel')} *`}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          maxLength={128}
          autoComplete="off"
          spellCheck={false}
          hint={t('netUserHint')}
          disabled={!allowed}
        />
        <Field
          label={`${t('netFeeLabel')} *`}
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          inputMode="decimal"
          hint={t('netFeeHint')}
          error={feeProblem ? t('netFeeError') : undefined}
          disabled={!allowed}
        />
        <PortalReview
          title={t('netCreateAction')}
          variant="primary"
          description={t('netCreateReview')}
          review={
            <dl data-testid="pp-facts" className="pp-facts">
              <div>
                <dt>{t('netUserLabel')}</dt>
                <dd>{userId.trim()}</dd>
              </div>
              <div>
                <dt>{t('colFee')}</dt>
                <dd>{bps === null ? '' : bpsPercent(bps)}</dd>
              </div>
            </dl>
          }
          perform={() => portal.subCreate({ parentMerchantId: merchantId, userId: userId.trim(), feeBps: bps! })}
          onConfirmed={() => {
            setUserId('');
            setFee('');
            done();
          }}
          disabled={why !== undefined}
          disabledReason={why}
        />
        {why && <p className="muted pp-note">{why}</p>}
      </div>
    </PaySection>
  );
}
