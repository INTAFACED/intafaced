import { useState } from 'react';
import type { z } from 'zod';
import { Button, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { DepthPanel, DisabledAction, Fact } from './DepthParts';
import { RecipientPicker } from './RecipientPicker';
import type { Payee } from './payees';
import {
  approvalActions,
  companySpaces,
  ownSpaceName,
  thresholdProblem,
  whoMade,
  type ApprovalAction,
  type Role,
  ROLES,
} from './business-model';
import { businessCopy } from './business-copy';
import {
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
import type { approvalSchema, businessSchema } from './contracts';
import { assetSelectField, useHoldings } from './holdings';
import { t as copyText } from './copy';
import './bank-depth.css';

type Business = z.infer<typeof businessSchema>;
type Approval = z.infer<typeof approvalSchema>;
type OwnSpace = { id: string; name: string; assetId: string; balance: string };

const verifyApproval = (key: 'approvalId') => (data: unknown, input: Record<string, unknown>) =>
  !!data && typeof data === 'object' && typeof input[key] === 'string';

function ApprovalRow({
  approval,
  me,
  spaces,
  open,
}: {
  approval: Approval;
  me: string | null;
  spaces: readonly OwnSpace[];
  open: (spec: ActionSpec) => void;
}) {
  const { t } = businessCopy.useCopy();
  const actions = approvalActions(approval, me);
  const label = (id: string) => ownSpaceName(spaces, id) ?? t('otherAccount');
  const act = (action: ApprovalAction) =>
    open({
      title: action === 'approve' ? t('approveTitle') : action === 'reject' ? t('rejectTitle') : t('cancelTitle'),
      procedure: action === 'approve' ? 'business.approve' : action === 'reject' ? 'business.reject' : 'business.cancel',
      facts: [
        [t('amountLabel'), funds(approval.amount, approval.assetId)],
        [t('fromAccount'), label(approval.fromSpaceId)],
        [t('toAccount'), label(approval.toSpaceId)],
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
        <Fact label={t('fromAccount')}>{label(approval.fromSpaceId)}</Fact>
        <Fact label={t('toAccount')}>{label(approval.toSpaceId)}</Fact>
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
          {actions.includes('approve') && <Button onClick={() => act('approve')}>{t('approve')}</Button>}
          {actions.includes('reject') && (
            <Button variant="secondary" onClick={() => act('reject')}>
              {t('reject')}
            </Button>
          )}
          {actions.includes('cancel') && (
            <Button variant="secondary" onClick={() => act('cancel')}>
              {t('cancel')}
            </Button>
          )}
        </div>
      )}
      {actions.includes('cancel') && <p className="money-caption">{t('selfApproveNote')}</p>}
    </article>
  );
}

function Approvals({ accountId, spaces, open }: { accountId: string; spaces: readonly OwnSpace[]; open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  const { userId } = useSession();
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('business.pending', { accountId, limit });
  return (
    <DepthPanel title={t('approvalsTitle')} lead={t('approvalsLead')}>
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((approval) => <ApprovalRow key={approval.id} approval={approval} me={userId ?? null} spaces={spaces} open={open} />)
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

function AddTeammate({ account, open }: { account: Business; open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  const [person, setPerson] = useState<Payee | null>(null);
  return (
    <DepthPanel title={t('membersTitle')} lead={t('addMemberChoose')}>
      <RecipientPicker value={person} onChange={setPerson} />
      <Button
        disabled={!person}
        onClick={() => {
          if (!person) return;
          open({
            title: t('addMemberTitle', { name: account.name }),
            procedure: 'business.addMember',
            fields: [
              {
                name: 'role',
                label: t('addMemberRole'),
                options: ROLES.map((role) => ({
                  value: role,
                  label:
                    role === 'admin' ? t('addMemberRoleAdmin') : role === 'maker' ? t('addMemberRoleMaker') : t('addMemberRoleChecker'),
                })),
              },
            ],
            facts: [[t('membersTitle'), `@${person.handle}`]],
            notes: [t('needsSecondStep')],
            submit: t('addMemberSubmit'),
            input: (values) => ({ accountId: account.id, userId: person.userId, role: values.role as Role }),
            verifyOutcome: (data, input) =>
              !!data &&
              typeof data === 'object' &&
              (data as Record<string, unknown>).accountId === input.accountId &&
              (data as Record<string, unknown>).userId === input.userId &&
              (data as Record<string, unknown>).role === input.role,
          });
        }}
      >
        {t('addMember')}
      </Button>
      <p className="money-caption">{t('membersReason')}</p>
    </DepthPanel>
  );
}

function AccountCard({ account, spaces, open }: { account: Business; spaces: readonly OwnSpace[]; open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  const [expanded, setExpanded] = useState(false);
  const own = companySpaces(spaces, account.assetId);
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
        <Button onClick={send} disabled={account.status !== 'active' || own.length < 2}>
          {t('sendMoney')}
        </Button>
        <Button variant="secondary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {t('membersTitle')}
        </Button>
      </div>
      {own.length < 2 && account.status === 'active' && <p className="money-caption">{t('sendNoSpaces')}</p>}
      <p className="money-caption">{t('sendReasonOther')}</p>
      <DisabledAction label={t('payroll')} reason={t('payrollReason')} />
      {expanded && <AddTeammate account={account} open={open} />}
      <Approvals accountId={account.id} spaces={spaces} open={open} />
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
