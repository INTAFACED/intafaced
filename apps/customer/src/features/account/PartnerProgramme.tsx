import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { partnerProgrammeCopy as copy } from './partner-programme-copy';

// Become an affiliate partner (CM-referral-05, RC-campaigns-07; J-campaigns-07). Apply against the owner's qualified
// invitee count, see the decision, and as an approved partner open the partner portal and my own sub-tree to the
// programme depth. Blank owner values refuse by name and nothing is recorded.
// hand-declared-ok: svc-identity's affiliates procedures have no browser-safe schema in packages/contracts yet
const eligibilitySchema = z.object({
  requiredCount: z.number().int().positive(),
  qualifiedCount: z.number().int().nonnegative(),
  eligible: z.boolean(),
});
const categories = ['not_enough_activity', 'incomplete_application', 'compliance', 'other'] as const;
const applicationSchema = z.object({
  applicationId: z.string().uuid(),
  state: z.enum(['submitted', 'approved', 'rejected']),
  qualifiedCount: z.number().int().nonnegative(),
  requiredCount: z.number().int().positive(),
  approvalReason: z.string().nullable(),
  rejectCategory: z.enum(categories).nullable(),
  reapplyAt: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
const subTreeSchema = z.object({
  depth: z.number().int().positive(),
  members: z.array(z.object({ handle: z.string(), level: z.number().int().positive(), joinedAt: z.string() })),
  beyondDepth: z.number().int().nonnegative(),
});
type Application = z.infer<typeof applicationSchema>;
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

const categoryKey = {
  not_enough_activity: 'catNotEnoughActivity',
  incomplete_application: 'catIncompleteApplication',
  compliance: 'catCompliance',
  other: 'catOther',
} as const;
const stateKey = { submitted: 'stateSubmitted', approved: 'stateApproved', rejected: 'stateRejected' } as const;
const day = (iso: string) => iso.slice(0, 10);

export function PartnerProgramme() {
  const { userId } = useSession();
  return userId ? <Programme key={userId} /> : null;
}

function RefusalNote({ refusal }: { refusal: Refusal }) {
  const { Copy } = copy.useCopy();
  const k =
    refusal.code === 'partner.eligibility_unset'
      ? 'eligibilityUnset'
      : refusal.code === 'affiliate.programme_depth_unset'
        ? 'depthUnset'
        : refusal.code === 'partner.reapply_too_soon'
          ? 'tooSoon'
          : 'refused';
  return (
    <div role="alert" data-testid="partner-refusal">
      <p>
        <Copy k={k} />
      </p>
      {refusal.code && (
        <p lang="zxx">
          HTTP {refusal.status} · {refusal.code}
        </p>
      )}
    </div>
  );
}

function Programme() {
  const { api } = useSession();
  const { t, Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'affiliates.myPartnerApplication', undefined, applicationSchema.nullable(), { signal }),
    'partner-application',
  );
  const [eligibility, setEligibility] = useState<z.infer<typeof eligibilitySchema> | null>(null);
  const [filed, setFiled] = useState<Application | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setRefusal(null);
    const answer = await api.query('identity', 'affiliates.partnerEligibility', undefined, eligibilitySchema);
    setBusy(false);
    if (answer.ok) setEligibility(answer.data);
    else setRefusal(answer);
  }
  async function submit() {
    setBusy(true);
    setRefusal(null);
    // Pressing again is safe: the service returns the open application.
    const answer = await api.mutate('identity', 'affiliates.applyPartner', {}, applicationSchema);
    setBusy(false);
    if (answer.ok) {
      setFiled(answer.data);
      setEligibility(null);
    } else setRefusal(answer);
  }

  const application = filed ?? (resource.status === 'ready' ? resource.data : null);
  const mayApply =
    !application || (application.state === 'rejected' && application.reapplyAt !== null && Date.now() >= Date.parse(application.reapplyAt));

  return (
    <section className="promotions__link" aria-label={t('title')}>
      <h2>
        <Copy k="title" />
      </h2>
      <p className="muted">
        <Copy k="intro" />
      </p>
      {resource.status === 'loading' && !filed ? (
        <Loading />
      ) : resource.status === 'failed' && !filed ? (
        <Failure result={resource.failure} retry={reload} />
      ) : (
        <>
          {application && <Status application={application} />}
          {mayApply && !eligibility && (
            <Button disabled={busy} onClick={() => void check()}>
              <Copy k="apply" />
            </Button>
          )}
          {mayApply && eligibility && (
            <div data-testid="partner-eligibility">
              <div className="promotions__visits">
                <span>
                  <Copy k="qualified" />
                </span>
                <strong lang="zxx" data-testid="partner-qualified">
                  {eligibility.qualifiedCount}
                </strong>
              </div>
              <div className="promotions__visits">
                <span>
                  <Copy k="required" />
                </span>
                <strong lang="zxx" data-testid="partner-required">
                  {eligibility.requiredCount}
                </strong>
              </div>
              <p className="promotions__caption">
                <Copy k="qualifiedMeaning" />
              </p>
              <p role="status">
                <Copy k={eligibility.eligible ? 'eligible' : 'notEligible'} />
              </p>
              {eligibility.eligible && (
                <Button disabled={busy} onClick={() => void submit()}>
                  <Copy k="submit" />
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {refusal && <RefusalNote refusal={refusal} />}
    </section>
  );
}

function Status({ application }: { application: Application }) {
  const { Copy } = copy.useCopy();
  return (
    <div data-testid="partner-application">
      <div className="promotions__visits">
        <span>
          <Copy k="status" />
        </span>
        <strong data-testid="partner-status">
          <Copy k={stateKey[application.state]} />
        </strong>
      </div>
      {application.state === 'submitted' && (
        <p className="muted">
          <Copy k="submittedBody" />
        </p>
      )}
      {application.state === 'rejected' && (
        <>
          <div className="promotions__visits">
            <span>
              <Copy k="rejectCategory" />
            </span>
            <strong data-testid="partner-reject-category">
              {application.rejectCategory ? <Copy k={categoryKey[application.rejectCategory]} /> : null}
            </strong>
          </div>
          {application.reapplyAt && (
            <div className="promotions__visits">
              <span>
                <Copy k="reapplyAt" />
              </span>
              <strong lang="zxx" data-testid="partner-reapply-at">
                {day(application.reapplyAt)}
              </strong>
            </div>
          )}
        </>
      )}
      {application.state === 'approved' && <Portal application={application} />}
    </div>
  );
}

function Portal({ application }: { application: Application }) {
  const { api } = useSession();
  const { t, Copy } = copy.useCopy();
  const [tree, setTree] = useState<z.infer<typeof subTreeSchema> | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    setRefusal(null);
    const answer = await api.query('identity', 'affiliates.mySubTree', undefined, subTreeSchema);
    setBusy(false);
    if (answer.ok) setTree(answer.data);
    else {
      setTree(null);
      setRefusal(answer);
    }
  }

  return (
    <section className="promotions__link" aria-label={t('portal')}>
      <h3>
        <Copy k="portal" />
      </h3>
      {application.approvalReason && (
        <div className="promotions__visits">
          <span>
            <Copy k="approvalReason" />
          </span>
          <strong data-testid="partner-approval-reason">{application.approvalReason}</strong>
        </div>
      )}
      <Button disabled={busy} onClick={() => void open()}>
        <Copy k="openTree" />
      </Button>
      {tree && (
        <div aria-label={t('tree')} role="region">
          <h4>
            <Copy k="tree" />
          </h4>
          <p className="muted">
            <Copy k="treeDepth" />{' '}
            <strong lang="zxx" data-testid="partner-tree-depth">
              {tree.depth}
            </strong>{' '}
            <Copy k="treeLevels" />
          </p>
          {tree.members.length === 0 ? (
            <p className="muted">
              <Copy k="treeEmpty" />
            </p>
          ) : (
            <table className="api-keys__table" data-testid="partner-tree">
              <thead>
                <tr>
                  <th>
                    <Copy k="colHandle" />
                  </th>
                  <th>
                    <Copy k="colLevel" />
                  </th>
                  <th>
                    <Copy k="colJoined" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {tree.members.map((m) => (
                  <tr key={m.handle} data-testid="partner-tree-member">
                    <td lang="zxx">{m.handle}</td>
                    <td lang="zxx">{m.level}</td>
                    <td lang="zxx">{day(m.joinedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="promotions__visits">
            <span>
              <Copy k="beyond" />
            </span>
            <strong lang="zxx" data-testid="partner-tree-beyond">
              {tree.beyondDepth}
            </strong>
          </div>
        </div>
      )}
      {refusal && <RefusalNote refusal={refusal} />}
    </section>
  );
}
