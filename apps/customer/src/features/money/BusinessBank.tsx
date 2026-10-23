import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { Button, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { fetchMe } from '../../data/identity';
import { DepthPanel, DisabledAction, Fact } from './DepthParts';
import { PayPerson, roleOf, TeamPanel, type RoleState } from './BusinessPeople';
import { PayrollRun } from './BusinessPayroll';
import {
  canSend,
  approvalActions,
  companySpaces,
  ownSpaceName,
  proposalMatches,
  proposalOutcome,
  shortRef,
  thresholdProblem,
  whoMade,
  type ApprovalAction,
  type Role,
} from './business-model';
import { businessCopy } from './business-copy';
import {
  amount as exactAmount,
  Continuation,
  date,
  funds,
  NoRows,
  positiveMoney,
  ResourceView,
  Section,
  useBankRead,
  usePageLimit,
  type ActionSpec,
} from './components';
import type { businessSchema, pendingApprovalSchema } from './contracts';
import { assetSelectField, useHoldings } from './holdings';
import { t as copyText } from './copy';
import './bank-depth.css';

type Business = z.infer<typeof businessSchema>;
type Approval = z.infer<typeof pendingApprovalSchema>;
type OwnSpace = { id: string; name: string; assetId: string; balance: string };

const verifyApproval = (key: 'approvalId') => (data: unknown, input: Record<string, unknown>) =>
  !!data && typeof data === 'object' && typeof input[key] === 'string';

export function ApprovalRow({
  approval,
  me,
  myHandle,
  role,
  spaces,
  open,
}: {
  approval: Approval;
  me: string | null;
  myHandle: string | null;
  /** The role the bank reports for this person. When it could not be read, every action stays offered and the bank decides. */
  role: Role | null;
  spaces: readonly OwnSpace[];
  open: (spec: ActionSpec) => void;
}) {
  const { t } = businessCopy.useCopy();
  const actions = approvalActions(approval, me, role);
  const unnamed = (id: string) => t('destinationUnnamed', { ref: id });
  const label = (id: string) => ownSpaceName(spaces, id) ?? unnamed(id);
  const destinationNamed = ownSpaceName(spaces, approval.toSpaceId) !== null;
  // Names come from the bank's own reading of the directory. Where it could not name someone, say so and keep the reference.
  const maker =
    whoMade(approval, me) === 'you'
      ? myHandle
        ? t('makerYou', { handle: myHandle })
        : t('makerYouNoHandle')
      : approval.makerHandle
        ? `@${approval.makerHandle}`
        : t('makerTeammate', { ref: shortRef(approval.makerUserId) });
  const owner = approval.receiverOwnerHandle
    ? approval.receiverOwnerName
      ? `${approval.receiverOwnerName} (@${approval.receiverOwnerHandle})`
      : `@${approval.receiverOwnerHandle}`
    : null;
  // Approving sends money to the receiving account, so the approver must be able to see whose it is.
  const blockApprove = !destinationNamed && owner === null;
  const act = (action: ApprovalAction) =>
    open({
      title: action === 'approve' ? t('approveTitle') : action === 'reject' ? t('rejectTitle') : t('cancelTitle'),
      procedure: action === 'approve' ? 'business.approve' : action === 'reject' ? 'business.reject' : 'business.cancel',
      facts: [
        // The decision is about this exact figure, so the confirmation never masks it.
        [t('amountLabel'), exactAmount(approval.amount, approval.assetId)],
        [t('makerLabel'), maker],
        [t('fromAccount'), label(approval.fromSpaceId)],
        [t('destinationLabel'), label(approval.toSpaceId)],
        ...(owner ? [[t('receiverOwnerLabel'), owner] as [string, string]] : []),
      ],
      notes: [action === 'approve' ? t('approveNote') : action === 'reject' ? t('rejectNote') : t('cancelNote'), t('needsSecondStep')],
      input: () => ({ approvalId: approval.id }),
      verifyOutcome: verifyApproval('approvalId'),
    });
  return (
    <article className="money-record bd-approval">
      <header>
        <div>
          <h3>{whoMade(approval, me) === 'you' ? t('proposedByYou') : t('proposedByTeammate')}</h3>
          <p>{date(approval.createdAt)}</p>
        </div>
        <strong className="numeric">{funds(approval.amount, approval.assetId)}</strong>
      </header>
      <dl className="bd-facts">
        <Fact label={t('makerLabel')}>{maker}</Fact>
        <Fact label={t('fromAccount')}>{label(approval.fromSpaceId)}</Fact>
        <Fact label={t('destinationLabel')}>
          <span lang="zxx" dir="ltr">
            {label(approval.toSpaceId)}
          </span>
        </Fact>
        {owner && <Fact label={t('receiverOwnerLabel')}>{owner}</Fact>}
        <Fact label={t('statusLabel')}>
          {approval.status === 'pending'
            ? t('pending')
            : approval.status === 'approved'
              ? t('approved')
              : approval.status === 'rejected'
                ? t('rejected')
                : t('cancelled')}
        </Fact>
      </dl>
      {actions.length > 0 && (
        <div className="actions">
          {actions.includes('approve') && (
            <Button
              onClick={() => act('approve')}
              disabled={blockApprove}
              aria-describedby={blockApprove ? `approve-why-${approval.id}` : undefined}
            >
              {t('approve')}
            </Button>
          )}
          {actions.includes('reject') && (
            <Button variant="secondary" onClick={() => act('reject')}>
              {t('reject')}
            </Button>
          )}
          {actions.includes('cancel') && (
            <Button variant="secondary" onClick={() => act('cancel')}>
              {whoMade(approval, me) === 'you' ? t('cancel') : t('adminCancel')}
            </Button>
          )}
        </div>
      )}
      {actions.includes('approve') && blockApprove && (
        <p id={`approve-why-${approval.id}`} className="money-caption" role="status">
          {t('approveBlocked')}
        </p>
      )}
      {actions.includes('approve') && <p className="money-caption">{t('roleNote')}</p>}
      {actions.includes('cancel') && whoMade(approval, me) === 'you' && <p className="money-caption">{t('selfApproveNote')}</p>}
      {actions.includes('cancel') && whoMade(approval, me) !== 'you' && <p className="money-caption">{t('adminCancelNote')}</p>}
    </article>
  );
}

function Approvals({
  accountId,
  role,
  spaces,
  open,
}: {
  accountId: string;
  role: Role | null;
  spaces: readonly OwnSpace[];
  open: (spec: ActionSpec) => void;
}) {
  const { t } = businessCopy.useCopy();
  const { api, userId } = useSession();
  const [myHandle, setMyHandle] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchMe(api, controller.signal).then((me) => {
      if (!controller.signal.aborted && me.kind === 'ok') setMyHandle(me.handle);
    });
    return () => controller.abort();
  }, [api, userId]);
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('business.pending', { accountId, limit });
  return (
    <DepthPanel title={t('approvalsTitle')} lead={t('approvalsLead')}>
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((approval) => (
                <ApprovalRow
                  key={approval.id}
                  approval={approval}
                  me={userId ?? null}
                  myHandle={myHandle}
                  role={role}
                  spaces={spaces}
                  open={open}
                />
              ))
            ) : (
              <NoRows title={t('approvalsEmpty')}>{t('approvalsEmptyBody')}</NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </DepthPanel>
  );
}

function AccountCard({ account, spaces, open }: { account: Business; spaces: readonly OwnSpace[]; open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  const [panel, setPanel] = useState<'team' | 'person' | 'payroll' | null>(null);
  const own = companySpaces(spaces, account.assetId);
  const roleRead = useBankRead('business.myRole', { accountId: account.id });
  const role: RoleState = roleRead.resource;
  const known = roleOf(role);
  const mayProposeUnknown = known === null || canSend(known);
  const toggle = (next: 'team' | 'person' | 'payroll') => setPanel(panel === next ? null : next);
  const send = () =>
    open({
      title: t('sendMoney'),
      procedure: 'business.proposeTransfer',
      fields: [
        {
          name: 'fromSpaceId',
          label: t('sendFrom'),
          options: own.map((space) => ({ value: space.id, label: `${space.name} · ${funds(space.balance, space.assetId)}` })),
        },
        {
          name: 'toSpaceId',
          label: t('sendTo'),
          options: own.map((space) => ({ value: space.id, label: space.name })),
        },
        positiveMoney(account.assetId, 'amount', t('sendAmount')),
      ],
      facts: [[t('threshold'), funds(account.spendThreshold, account.assetId)]],
      notes: [t('sendNote'), t('needsSecondStep')],
      validate: (input) => (input.fromSpaceId === input.toSpaceId ? copyText('client.choose.a.different.destination.space') : null),
      input: (values, requestId) => ({
        accountId: account.id,
        fromSpaceId: values.fromSpaceId,
        toSpaceId: values.toSpaceId,
        amount: values.amount,
        clientId: requestId,
      }),
      verifyOutcome: proposalMatches,
      describeOutcome: (data, input) => {
        const outcome = proposalOutcome(data);
        if (!outcome) return null;
        const name = (id: unknown) => ownSpaceName(own, String(id)) ?? String(id);
        return [
          [t('outcomeResult'), outcome === 'pending' ? t('outcomePending') : t('outcomePosted')],
          [t('amountLabel'), funds(String(input.amount), account.assetId)],
          [t('fromAccount'), name(input.fromSpaceId)],
          [t('toAccount'), name(input.toSpaceId)],
        ];
      },
    });
  return (
    <article className="money-record bd-account">
      <header>
        <div>
          <h3>{account.name}</h3>
          <p>
            {account.assetId} · {account.status === 'active' ? t('active') : t('closed')}
          </p>
        </div>
        <span className="badge">{account.status === 'active' ? t('active') : t('closed')}</span>
      </header>
      <dl className="bd-facts">
        <Fact label={t('threshold')}>
          <span className="numeric">{funds(account.spendThreshold, account.assetId)}</span>
        </Fact>
        <Fact label={t('created')}>{date(account.createdAt)}</Fact>
      </dl>
      <div className="actions">
        <Button onClick={send} disabled={account.status !== 'active' || own.length < 2 || !mayProposeUnknown}>
          {t('sendTargetOwn')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => toggle('person')}
          aria-expanded={panel === 'person'}
          disabled={account.status !== 'active'}
        >
          {t('sendTargetPerson')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => toggle('payroll')}
          aria-expanded={panel === 'payroll'}
          disabled={account.status !== 'active'}
        >
          {t('payroll')}
        </Button>
        <Button variant="secondary" onClick={() => toggle('team')} aria-expanded={panel === 'team'}>
          {t('membersTitle')}
        </Button>
      </div>
      {own.length < 2 && account.status === 'active' && <p className="money-caption">{t('sendNoSpaces')}</p>}
      {known !== null && !canSend(known) && account.status === 'active' && <p className="money-caption">{t('sendRoleReason')}</p>}
      {role.status === 'failed' && <p className="money-caption">{t('roleUnreadable')}</p>}
      {panel === 'person' && <PayPerson account={account} own={own} role={role} open={open} />}
      {panel === 'payroll' && <PayrollRun account={account} own={own} role={role} open={open} />}
      {panel === 'team' && <TeamPanel account={account} role={role} open={open} />}
      <Approvals accountId={account.id} role={known} spaces={spaces} open={open} />
    </article>
  );
}

/** `/bank/business`: open a company account, pay with a second person's approval, and decide on waiting payments. */
export function BusinessBank({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('business.list', { limit });
  const held = useHoldings();
  const assets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const spaces: OwnSpace[] = held.resource.status === 'ready' ? held.resource.data.spaces : [];
  const create = () =>
    open({
      title: t('openTitle'),
      procedure: 'business.create',
      fields: [
        {
          name: 'name',
          label: t('openName'),
          validate: (value) => (value.length <= 128 ? null : copyText('rooms.use.64.characters.or.fewer')),
        },
        assetSelectField(t('openAsset'), t('openAssetHint'), assets),
        {
          ...positiveMoney(undefined, 'spendThreshold', t('openThreshold')),
          hint: t('openThresholdHint'),
          validate: (value) => (thresholdProblem(value) ? copyText('components.enter.an.exact.decimal.amount.greater.than') : null),
        },
      ],
      notes: [t('openLead'), t('openNote')],
      submit: t('openButton'),
      input: (values) => ({ name: (values.name ?? '').trim(), assetId: values.assetId, spendThreshold: values.spendThreshold }),
    });
  return (
    <>
      <DepthPanel title={t('openTitle')} lead={t('openLead')}>
        <div className="actions">
          <Button onClick={create} disabled={assets.length === 0} aria-describedby={assets.length === 0 ? 'business-open-why' : undefined}>
            {t('openButton')}
          </Button>
        </div>
        {assets.length === 0 && held.resource.status === 'ready' && (
          <p id="business-open-why" className="money-caption">
            {t('openNoAssets')}
          </p>
        )}
      </DepthPanel>
      <Section
        title={t('accountsTitle')}
        actions={
          <Button variant="ghost" onClick={query.reload}>
            {t('refresh')}
          </Button>
        }
      >
        <ResourceView resource={query.resource} reload={query.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((account) => <AccountCard key={account.id} account={account} spaces={spaces} open={open} />)
              ) : (
                <NoRows title={t('accountsEmptyTitle')}>{t('accountsEmptyBody')}</NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
    </>
  );
}
