import { useState } from 'react';
import { EmptyState, Field } from '../../../ui-kit';
import { useResource, type Resource } from '../../../../../shared/resource';
import { PaySection } from '../../../components';
import { useMerchantAccess } from '../../access/MerchantAccess';
import { SelectField, Timeline } from '../../components';
import { useUrlParam } from '../../hooks';
import type { PortalApi } from '../../api';
import { DateTime } from '../../ui/DateTime';
import { EntityList } from '../../ui/EntityList';
import { PortalReview } from '../../ui/PortalReview';
import { reason as notLive } from '../../chrome/copy';
import { accountCopy } from '../account/copy';
import { portalCopy } from '../copy';
import { areaWords, isPlatformAccount, nodeName } from '../account/model';
import type { Grant, PermissionEvent, SubMerchant } from '../account/schemas';
import { ReadGate } from '../account/ui';
import { NotPlatform } from './Network';

/** `/pay/permissions`: which areas of a sub-merchant other businesses on the platform may act in. Every change is reviewed and recorded. */
export function Permissions({ portal, merchantId, mode }: { portal: PortalApi; merchantId: string; mode: string | null }) {
  const [child, setChild] = useUrlParam('child');
  const { canOwnerWrite } = useMerchantAccess();
  const subs = useResource((s) => portal.subList(merchantId, s), `portal:subs:${merchantId}`);
  const areas = useResource((s) => portal.permAreas(s), 'portal:perm-areas');
  const selected = child || (subs.resource.status === 'ready' ? (subs.resource.data[0]?.id ?? '') : '');
  const grants = useResource(
    (s) => (selected ? portal.permGrants(selected, s) : Promise.resolve({ ok: true as const, data: [] as Grant[] })),
    `portal:perm-grants:${selected}`,
  );
  const history = useResource(
    (s) => (selected ? portal.permHistory(selected, s) : Promise.resolve({ ok: true as const, data: [] as PermissionEvent[] })),
    `portal:perm-history:${selected}`,
  );
  if (!isPlatformAccount(mode)) return <NotPlatform />;
  return (
    <PermissionsView
      portal={portal}
      subs={subs.resource}
      areas={areas.resource}
      grants={grants.resource}
      history={history.resource}
      selected={selected}
      select={setChild}
      mayWrite={canOwnerWrite}
      reload={() => {
        grants.reload();
        history.reload();
      }}
      reloadAll={() => {
        subs.reload();
        areas.reload();
        grants.reload();
        history.reload();
      }}
    />
  );
}

export function PermissionsView(props: {
  portal: PortalApi;
  subs: Resource<SubMerchant[]>;
  areas: Resource<string[]>;
  grants: Resource<Grant[]>;
  history: Resource<PermissionEvent[]>;
  selected: string;
  select: (id: string) => void;
  mayWrite: boolean;
  reload: () => void;
  reloadAll: () => void;
}) {
  const { t } = accountCopy.useCopy();
  return (
    <div className="stack">
      <ReadGate
        resource={props.subs}
        retry={props.reloadAll}
        waiting={{ reason: notLive('reasonNetwork'), body: t('netWaitBody'), needs: 'submerchant.list' }}
        rows={3}
      >
        {(subs) =>
          subs.length === 0 ? (
            <EmptyState
              title={t('netEmptyTitle')}
              action={
                <a className="text-link" href="/pay/network">
                  {t('permAddFirst')}
                </a>
              }
            >
              {t('permNoSubs')}
            </EmptyState>
          ) : (
            <Body {...props} subs={subs} />
          )
        }
      </ReadGate>
    </div>
  );
}

function Body(props: Omit<Parameters<typeof PermissionsView>[0], 'subs'> & { subs: SubMerchant[] }) {
  const { t } = accountCopy.useCopy();
  const { t: p } = portalCopy.useCopy();
  const { portal, subs, selected } = props;
  const label = (id: string) => {
    const node = subs.find((s) => s.id === id);
    return node ? nodeName(node, t('subWord')) : t('permOtherBusiness');
  };
  const subject = subs.find((s) => s.id === selected) ?? subs[0]!;
  const [grantee, setGrantee] = useState('');
  const [area, setArea] = useState('');
  const [reason, setReason] = useState('');
  const areaList = props.areas.status === 'ready' ? props.areas.data : [];
  const target = grantee || (subs.find((s) => s.id !== subject.id)?.id ?? '');
  const chosenArea = area || areaList[0] || '';
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  const why = !props.mayWrite
    ? t('permOwnerOnly')
    : !target
      ? t('permNeedGrantee')
      : !chosenArea
        ? t('permNeedArea')
        : !reasonOk
          ? t('reasonNeeded')
          : undefined;
  const input = { granteeMerchantId: target, subjectMerchantId: subject.id, area: chosenArea, reason: reason.trim() };
  const review = (
    <dl data-testid="pp-facts" className="pp-facts">
      <div>
        <dt>{t('permSubject')}</dt>
        <dd>{label(subject.id)}</dd>
      </div>
      <div>
        <dt>{t('permGrantee')}</dt>
        <dd>{label(target)}</dd>
      </div>
      <div>
        <dt>{t('permArea')}</dt>
        <dd>{areaWords(chosenArea)}</dd>
      </div>
      <div>
        <dt>{t('fReason')}</dt>
        <dd>{reason.trim()}</dd>
      </div>
    </dl>
  );
  return (
    <>
      <PaySection title={t('permSubjectTitle')} description={t('permSubjectBody')}>
        <SelectField
          label={t('permSubject')}
          value={subject.id}
          onChange={props.select}
          options={subs.map((s) => [s.id, nodeName(s, t('subWord'))] as const)}
        />
        <Field
          label={`${t('fReason')} *`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          hint={t('permReasonHint')}
        />
      </PaySection>

      <PaySection title={t('permGrantsTitle')} description={t('permGrantsBody')}>
        <ReadGate
          resource={props.grants}
          retry={props.reload}
          waiting={{ reason: notLive('reasonNetwork'), body: t('netWaitBody'), needs: 'submerchant.list' }}
        >
          {(grants) =>
            grants.length === 0 ? (
              <EmptyState title={t('permNoGrants')}>{t('permNoGrantsBody')}</EmptyState>
            ) : (
              <EntityList
                label={t('permGrantsTitle')}
                rows={grants}
                rowKey={(g) => `${g.area}:${g.granteeMerchantId}`}
                columns={[
                  { header: t('permArea'), cell: (g) => <strong>{areaWords(g.area)}</strong> },
                  { header: t('permGrantee'), cell: (g) => label(g.granteeMerchantId) },
                  { header: t('fReason'), cell: (g) => g.reason },
                  { header: t('colWhen'), cell: (g) => <DateTime value={g.grantedAt} /> },
                  {
                    header: p('colActions'),
                    cell: (g) => (
                      <PortalReview
                        title={t('permRevoke')}
                        variant="sell"
                        description={t('permRevokeBody')}
                        review={
                          <dl data-testid="pp-facts" className="pp-facts">
                            <div>
                              <dt>{t('permArea')}</dt>
                              <dd>{areaWords(g.area)}</dd>
                            </div>
                            <div>
                              <dt>{t('permGrantee')}</dt>
                              <dd>{label(g.granteeMerchantId)}</dd>
                            </div>
                            <div>
                              <dt>{t('fReason')}</dt>
                              <dd>{reason.trim()}</dd>
                            </div>
                          </dl>
                        }
                        perform={() =>
                          portal.permRevoke({
                            granteeMerchantId: g.granteeMerchantId,
                            subjectMerchantId: subject.id,
                            area: g.area,
                            reason: reason.trim(),
                          })
                        }
                        onConfirmed={props.reload}
                        disabled={!props.mayWrite || !reasonOk}
                        disabledReason={!props.mayWrite ? t('permOwnerOnly') : t('reasonNeeded')}
                      />
                    ),
                  },
                ]}
                card={(g) => ({ title: areaWords(g.area), time: label(g.granteeMerchantId), status: <DateTime value={g.grantedAt} /> })}
              />
            )
          }
        </ReadGate>
      </PaySection>

      <PaySection title={t('permChangeTitle')} description={t('permChangeBody')}>
        <div data-testid="form-stack" className="form-stack pp-form">
          <SelectField
            label={t('permGrantee')}
            value={target}
            onChange={setGrantee}
            options={subs.filter((s) => s.id !== subject.id).map((s) => [s.id, nodeName(s, t('subWord'))] as const)}
            hint={subs.length < 2 ? t('permNoGrantee') : undefined}
          />
          <SelectField
            label={t('permArea')}
            value={chosenArea}
            onChange={setArea}
            options={areaList.map((a) => [a, areaWords(a)] as const)}
          />
          <PortalReview
            title={t('permGrant')}
            variant="primary"
            description={t('permGrantBody')}
            review={review}
            perform={() => portal.permGrant(input)}
            onConfirmed={() => {
              setReason('');
              props.reload();
            }}
            disabled={why !== undefined}
            disabledReason={why}
          />
          {why && <p className="muted pp-note">{why}</p>}
        </div>
      </PaySection>

      <PaySection title={t('permHistoryTitle')} description={t('permHistoryBody')}>
        <ReadGate
          resource={props.history}
          retry={props.reload}
          waiting={{ reason: notLive('reasonNetwork'), body: t('netWaitBody'), needs: 'submerchant.list' }}
        >
          {(events) =>
            events.length === 0 ? (
              <EmptyState title={t('permNoHistory')}>{t('permNoHistoryBody')}</EmptyState>
            ) : (
              <Timeline
                label={t('permHistoryTitle')}
                items={events.map((e) => ({
                  at: e.createdAt,
                  title: t(e.action === 'grant' ? 'permEvGrant' : 'permEvRevoke', {
                    area: areaWords(e.area),
                    who: label(e.granteeMerchantId),
                  }),
                  detail: e.reason,
                }))}
              />
            )
          }
        </ReadGate>
      </PaySection>
    </>
  );
}
