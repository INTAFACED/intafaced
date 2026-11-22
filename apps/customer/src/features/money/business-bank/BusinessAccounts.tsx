import { useEffect, useState } from 'react';
import { BANK_BUSINESS_LIST } from '@intafaced/contracts/bank-business-procedures';
import { BANK_BUSINESS_MY_ROLE } from '@intafaced/contracts/bank-business-procedures';
import { BANK_BUSINESS_PENDING } from '@intafaced/contracts/bank-business-procedures';
import type { z } from 'zod';
import { Button, EmptyState, Tag } from '@intafaced/ui/lit';
import { useSession } from '../../session';
import { fetchMe } from '../../../data/identity';
import { Continuation, Fact, Panel, ResourceView } from '../bank-settings/parts';
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
} from '../business-model';
import { businessCopy } from '../business-copy';
import {
  amount as exactAmount,
  date,
  funds,
  positiveMoney,
  usePageLimit,
  type ActionSpec,
  useBankRecord,
  useBankRecordAs,
} from '../components';
import { myRoleSchema, pendingApprovalsSchema, type businessSchema, type pendingApprovalSchema } from '../contracts';
import { assetSelectField, useHoldings } from '../holdings';
import { t as copyText } from '../copy';

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
    <article>
      <header>
        <div>
          <h3>{whoMade(approval, me) === 'you' ? t('proposedByYou') : t('proposedByTeammate')}</h3>
          <p>{date(approval.createdAt)}</p>
        </div>
        <strong className="lt-mono">{funds(approval.amount, approval.assetId)}</strong>
      </header>
      <dl className="lt-kv">
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
        <div className="lt-actions">
          {actions.includes('approve') && (
            <Button
              tone="primary"
              onClick={() => act('approve')}
              disabled={blockApprove}
              aria-describedby={blockApprove ? `approve-why-${approval.id}` : undefined}
            >
              {t('approve')}
            </Button>
          )}
          {actions.includes('reject') && (
            <Button tone="secondary" onClick={() => act('reject')}>
              {t('reject')}
            </Button>
          )}
          {actions.includes('cancel') && (
            <Button tone="secondary" onClick={() => act('cancel')}>
              {whoMade(approval, me) === 'you' ? t('cancel') : t('adminCancel')}
            </Button>
          )}
        </div>
      )}
      {actions.includes('approve') && blockApprove && (
        <p id={`approve-why-${approval.id}`} className="lt-hint" role="status">
          {t('approveBlocked')}
        </p>
      )}
      {actions.includes('approve') && <p className="lt-hint">{t('roleNote')}</p>}
      {actions.includes('cancel') && whoMade(approval, me) === 'you' && <p className="lt-hint">{t('selfApproveNote')}</p>}
      {actions.includes('cancel') && whoMade(approval, me) !== 'you' && <p className="lt-hint">{t('adminCancelNote')}</p>}
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
  const query = useBankRecordAs(BANK_BUSINESS_PENDING, { accountId, limit }, pendingApprovalsSchema);
  return (
    <Panel level={3} title={t('approvalsTitle')} lead={t('approvalsLead')}>
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
              <EmptyState title={t('approvalsEmpty')} body={t('approvalsEmptyBody')} />
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Panel>
  );
}

function AccountCard({ account, spaces, open }: { account: Business; spaces: readonly OwnSpace[]; open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  const [panel, setPanel] = useState<'team' | 'person' | 'payroll' | null>(null);
  const own = companySpaces(spaces, account.assetId);
  const roleRead = useBankRecordAs(BANK_BUSINESS_MY_ROLE, { accountId: account.id }, myRoleSchema);
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
    <article>
      <header>
        <div>
          <h3>{account.name}</h3>
          <p>
            {account.assetId} · {account.status === 'active' ? t('active') : t('closed')}
          </p>
        </div>
        <Tag>{account.status === 'active' ? t('active') : t('closed')}</Tag>
      </header>
      <dl className="lt-kv">
        <Fact label={t('threshold')}>
          <span className="lt-mono">{funds(account.spendThreshold, account.assetId)}</span>
        </Fact>
        <Fact label={t('created')}>{date(account.createdAt)}</Fact>
      </dl>
      <div className="lt-actions">
        <Button tone="primary" onClick={send} disabled={account.status !== 'active' || own.length < 2 || !mayProposeUnknown}>
          {t('sendTargetOwn')}
        </Button>
        <Button tone="secondary" onClick={() => toggle('person')} aria-expanded={panel === 'person'} disabled={account.status !== 'active'}>
          {t('sendTargetPerson')}
        </Button>
        <Button
          tone="secondary"
          onClick={() => toggle('payroll')}
          aria-expanded={panel === 'payroll'}
          disabled={account.status !== 'active'}
        >
          {t('payroll')}
        </Button>
        <Button tone="secondary" onClick={() => toggle('team')} aria-expanded={panel === 'team'}>
          {t('membersTitle')}
        </Button>
      </div>
      {own.length < 2 && account.status === 'active' && <p className="lt-hint">{t('sendNoSpaces')}</p>}
      {known !== null && !canSend(known) && account.status === 'active' && <p className="lt-hint">{t('sendRoleReason')}</p>}
      {role.status === 'failed' && <p className="lt-hint">{t('roleUnreadable')}</p>}
      {panel === 'person' && <PayPerson account={account} own={own} role={role} open={open} />}
      {panel === 'payroll' && <PayrollRun account={account} own={own} role={role} open={open} />}
      {panel === 'team' && <TeamPanel account={account} role={role} open={open} />}
      <Approvals accountId={account.id} role={known} spaces={spaces} open={open} />
    </article>
  );
}

/** `/bank/business`'s sections: open a company account, pay with a second person's approval, and decide on waiting payments. */
export function BusinessSections({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  const [limit, setLimit] = usePageLimit();
  const query = useBankRecord(BANK_BUSINESS_LIST, { limit });
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
      // The request id is the new account's id, so a resend after a lost answer opens the same account once.
      input: (values, requestId) => ({
        accountId: requestId,
        name: (values.name ?? '').trim(),
        assetId: values.assetId,
        spendThreshold: values.spendThreshold,
      }),
    });
  return (
    <>
      <Panel id="business-open" title={t('openTitle')} lead={t('openLead')}>
        <div className="lt-actions">
          <Button
            tone="primary"
            onClick={create}
            disabled={assets.length === 0}
            aria-describedby={assets.length === 0 ? 'business-open-why' : undefined}
          >
            {t('openButton')}
          </Button>
        </div>
        {assets.length === 0 && held.resource.status === 'ready' && (
          <p id="business-open-why" className="lt-hint">
            {t('openNoAssets')}
          </p>
        )}
      </Panel>
      <Panel
        id="business-accounts"
        title={t('accountsTitle')}
        actions={
          <Button tone="quiet" onClick={query.reload}>
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
                <EmptyState title={t('accountsEmptyTitle')} body={t('accountsEmptyBody')} />
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Panel>
    </>
  );
}
