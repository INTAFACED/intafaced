import { copy, t as copyText, Text } from './copy';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Dialog, EmptyState, Failure, Field, Loading, Page, Panel, DataTable } from '../../shared/ui';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { View } from './View';
import { Security } from './Security';
import { Notifications } from './Notifications';
import { ReferralRecords } from './ReferralRecords';
import './account.css';

const subAccountSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  purpose: z.string().nullable(),
  revoked: z.boolean(),
  createdAt: z.string(),
});
const kycRecord = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  tier: z.enum(['none', 'basic', 'full', 'institutional']),
  jurisdiction: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  reviewedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export function AccountRoutes({ path }: { path: string }) {
  const { languageFor } = copy.useCopy();
  return (
    <div lang={languageFor('accountroutes.account')} style={{ display: 'contents' }}>
      <AccountRooms path={path} />
    </div>
  );
}
function AccountRooms({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean === '/view') return <View />;
  if (clean === '/uc/safe') return <Security />;
  if (clean === '/verification') return <Verification />;
  if (clean === '/notifications') return <Notifications />;
  if (clean === '/identbusiness')
    return (
      <Page title={copyText('accountroutes.business.verification')}>
        <EmptyState
          title={copyText('accountroutes.verified.company.accounts.are.not.connected')}
          action={
            <a href="/verification" className="text-link">
              <Text k="accountroutes.view.personal.verification" />
            </a>
          }
        >
          <Text k="accountroutes.company.identity.owner.membership.and.the.associated" />
        </EmptyState>
      </Page>
    );
  if (clean?.startsWith('/uc/promotion') || clean === '/uc/invitingmining') return <Promotions />;
  if (clean === '/uc/paydividends')
    return (
      <Page title={copyText('accountroutes.dividend.records')}>
        <EmptyState title={copyText('accountroutes.dividend.history.is.not.connected')}>
          <Text k="accountroutes.there.is.no.mounted.owner.scoped.dividend" />
        </EmptyState>
        <div className="actions">
          <a className="text-link" href="/token">
            <Text k="accountroutes.open.token" />
          </a>
          <a className="text-link" href="/bank/earn">
            <Text k="accountroutes.open.earn" />
          </a>
        </div>
      </Page>
    );
  return <Account />;
}
function ResultNotice({ result }: { result: ApiResult<unknown> | null }) {
  if (!result) return null;
  return result.ok ? (
    <p className="notice" role="status">
      <Text k="accountroutes.the.service.confirmed.the.action" />
    </p>
  ) : (
    <div lang="und">
      <Failure result={result} />
    </div>
  );
}
function Account() {
  const { api, session } = useSession();
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'subAccounts.list', { limit }, z.array(subAccountSchema), { signal }),
    `subaccounts:${session?.userId}:${limit}`,
  );
  const [label, setLabel] = useState('');
  const [purpose, setPurpose] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiResult<unknown> | null>(null);
  const [revoke, setRevoke] = useState<z.infer<typeof subAccountSchema> | null>(null);
  const [review, setReview] = useState(false);
  async function create() {
    setPending(true);
    const response = await api.mutate(
      'identity',
      'subAccounts.create',
      { label: label.trim(), ...(purpose.trim() ? { purpose: purpose.trim() } : {}) },
      z.object({ id: z.string().uuid() }),
    );
    setPending(false);
    setResult(response);
    setReview(false);
    if (response.ok) {
      setLabel('');
      setPurpose('');
      reload();
    }
  }
  async function retire() {
    if (!revoke) return;
    setPending(true);
    const response = await api.mutate('identity', 'subAccounts.revoke', { subAccountId: revoke.id }, z.object({ revoked: z.boolean() }));
    setPending(false);
    setResult(response);
    setRevoke(null);
    if (response.ok) reload();
  }
  return (
    <Page
      title={copyText('accountroutes.account')}
      description={copyText('accountroutes.your.identity.and.strategy.partitions.a.strategy')}
    >
      <div className="account-summary">
        <span className="eyebrow">
          <Text k="accountroutes.personal.account" />
        </span>
        <h2 className="numeric" lang="zxx">
          {session?.userId}
        </h2>
        <div className="actions">
          <a className="text-link" href="/verification">
            <Text k="accountroutes.verification" />
          </a>
          <a className="text-link" href="/uc/safe">
            <Text k="accountroutes.security" />
          </a>
        </div>
      </div>
      <div className="split">
        <section className="stack">
          <div className="section-heading">
            <h2>
              <Text k="accountroutes.strategy.subaccounts" />
            </h2>
            <Button variant="ghost" onClick={reload}>
              <Text k="accountroutes.refresh" />
            </Button>
          </div>
          {resource.status === 'loading' ? (
            <Loading />
          ) : resource.status === 'failed' ? (
            <div lang="und">
              <Failure result={resource.failure} retry={reload} />
            </div>
          ) : resource.data.length === 0 ? (
            <EmptyState title={copyText('accountroutes.no.strategy.subaccounts')}>
              <Text k="accountroutes.create.a.labelled.partition.for.a.strategy" />
            </EmptyState>
          ) : (
            <>
              <DataTable
                label={copyText('accountroutes.your.strategy.subaccounts')}
                headers={[
                  copyText('accountroutes.label'),
                  copyText('accountroutes.purpose'),
                  copyText('accountroutes.status'),
                  copyText('accountroutes.action'),
                ]}
              >
                {resource.data.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <strong lang="und">{account.label}</strong>
                      <small className="account-id numeric" lang="zxx">
                        {account.id}
                      </small>
                    </td>
                    <td lang="und">{account.purpose ?? '—'}</td>
                    <td>{account.revoked ? copyText('accountroutes.revoked') : copyText('accountroutes.active')}</td>
                    <td>
                      <Button variant="ghost" disabled={account.revoked || pending} onClick={() => setRevoke(account)}>
                        <Text k="accountroutes.revoke" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </DataTable>
              {resource.data.length === limit && (
                <div className="notice">
                  <Text k="accountroutes.this.is.the.returned.window.not.a" />{' '}
                  {limit < 200 && (
                    <Button variant="ghost" onClick={() => setLimit(200)}>
                      <Text k="accountroutes.load.up.to.200" />
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
        <Panel title={copyText('accountroutes.create.a.strategy.subaccount')}>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              setReview(true);
            }}
          >
            <Field
              label={copyText('accountroutes.label')}
              name="subaccount-label"
              required
              maxLength={64}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Field
              label={copyText('accountroutes.purpose.optional')}
              name="subaccount-purpose"
              maxLength={200}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            />
            <Button type="submit" disabled={pending || (result?.ok === false && result.reason === 'uncertain')}>
              <Text k="accountroutes.review.subaccount" />
            </Button>
          </form>
        </Panel>
      </div>
      <ResultNotice result={result} />
      {review && (
        <Dialog title={copyText('accountroutes.create.strategy.subaccount')} onClose={() => !pending && setReview(false)}>
          <div className="stack">
            <p>
              <strong lang="und">{label.trim()}</strong>
            </p>
            <p className="muted" lang={purpose.trim() ? 'und' : undefined}>
              {purpose.trim() || copyText('accountroutes.no.purpose.supplied')}
            </p>
            <p className="muted">
              <Text k="accountroutes.this.creates.a.partition.without.moving.funds" />
            </p>
            <Button onClick={() => void create()} disabled={pending}>
              {pending ? copyText('accountroutes.creating') : copyText('accountroutes.create.subaccount')}
            </Button>
          </div>
        </Dialog>
      )}
      {revoke && (
        <Dialog title={copyText('accountroutes.revoke.strategy.subaccount')} onClose={() => !pending && setRevoke(null)}>
          <div className="stack">
            <p>
              <Text k="accountroutes.revoke.2" />
              <strong lang="und">{revoke.label}</strong>?
            </p>
            <p className="muted">
              <Text k="accountroutes.the.account.is.disabled.its.ledger.balances" />
            </p>
            <Button variant="danger" onClick={() => void retire()} disabled={pending}>
              <Text k="accountroutes.revoke.subaccount" />
            </Button>
          </div>
        </Dialog>
      )}
    </Page>
  );
}
function Verification() {
  const { api, session } = useSession();
  const { requestedLocale } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) =>
      api.query(
        'identity',
        'kyc.status',
        { limit: 50 },
        z
          .object({ tier: z.enum(['none', 'basic', 'full', 'institutional']), records: z.array(kycRecord) })
          .refine(
            (value) => value.records.every((record) => record.userId === session?.userId),
            copyText('accountroutes.verification.belongs.to.another.account'),
          ),
        { signal },
      ),
    `kyc:${session?.userId}`,
  );
  const [tier, setTier] = useState('basic');
  const [country, setCountry] = useState('');
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiResult<unknown> | null>(null);
  async function request() {
    setPending(true);
    const response = await api.mutate('identity', 'kyc.submit', { tier, jurisdiction: country.toUpperCase() }, kycRecord);
    setPending(false);
    setResult(response);
    setReview(false);
    if (response.ok) reload();
  }
  return (
    <Page title={copyText('accountroutes.verification.2')} description={copyText('accountroutes.see.your.current.tier.and.request.review')}>
      <div className="split">
        <section className="stack">
          {resource.status === 'loading' ? (
            <Loading />
          ) : resource.status === 'failed' ? (
            <div lang="und">
              <Failure result={resource.failure} retry={reload} />
            </div>
          ) : (
            <>
              <div className="account-summary">
                <span className="eyebrow">
                  <Text k="accountroutes.current.verified.tier" />
                </span>
                <h2 lang="zxx">{resource.data.tier}</h2>
              </div>
              {resource.data.records.length ? (
                <DataTable
                  headers={[
                    copyText('accountroutes.requested.tier'),
                    copyText('accountroutes.country'),
                    copyText('accountroutes.status'),
                    copyText('accountroutes.requested'),
                  ]}
                  label={copyText('accountroutes.verification.requests')}
                >
                  {resource.data.records.map((record) => (
                    <tr key={record.id}>
                      <td lang="zxx">{record.tier}</td>
                      <td lang="zxx">{record.jurisdiction}</td>
                      <td lang="zxx">{record.status}</td>
                      <td>
                        <time dateTime={record.createdAt} lang={requestedLocale}>
                          {new Date(record.createdAt).toLocaleDateString(requestedLocale)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <EmptyState title={copyText('accountroutes.no.verification.requests.returned')}>
                  <Text k="accountroutes.request.the.tier.needed.for.your.account" />
                </EmptyState>
              )}
              <p className="muted">
                <Text k="accountroutes.up.to.50.requests.document.uploads.and" />
              </p>
            </>
          )}
        </section>
        <Panel title={copyText('accountroutes.request.verification')}>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              setReview(true);
            }}
          >
            <label className="field">
              <span>
                <Text k="accountroutes.requested.tier" />
              </span>
              <select value={tier} onChange={(event) => setTier(event.target.value)}>
                <option value="basic">
                  <Text k="accountroutes.basic" />
                </option>
                <option value="full">
                  <Text k="accountroutes.full" />
                </option>
                <option value="institutional">
                  <Text k="accountroutes.institutional" />
                </option>
              </select>
            </label>
            <Field
              label={copyText('accountroutes.country.code')}
              name="kyc-country"
              required
              minLength={2}
              maxLength={2}
              pattern="[a-zA-Z]{2}"
              value={country}
              onChange={(event) => setCountry(event.target.value)}
              hint={copyText('accountroutes.iso.two.letter.jurisdiction.code')}
            />
            <Button type="submit" disabled={pending || (result?.ok === false && result.reason === 'uncertain')}>
              <Text k="accountroutes.review.request" />
            </Button>
          </form>
        </Panel>
      </div>
      <ResultNotice result={result} />
      {review && (
        <Dialog title={copyText('accountroutes.request.verification.review')} onClose={() => !pending && setReview(false)}>
          <div className="stack">
            <p lang="zxx">
              {tier} · {country.toUpperCase()}
            </p>
            <p className="muted">
              <Text k="accountroutes.this.creates.a.pending.request.your.current" />
            </p>
            <Button disabled={pending} onClick={() => void request()}>
              <Text k="accountroutes.submit.request" />
            </Button>
          </div>
        </Dialog>
      )}
    </Page>
  );
}
function Promotions() {
  const { api } = useSession();
  const [result, setResult] = useState<ApiResult<{ token: string; referrerId: string; hits: number }> | null>(null);
  const [pending, setPending] = useState(false);
  const [copy, setCopy] = useState('');
  async function create() {
    setPending(true);
    const response = await api.mutate(
      'identity',
      'affiliates.createShare',
      {},
      z.object({ token: z.string().uuid(), referrerId: z.string().uuid(), hits: z.number().int() }),
    );
    setPending(false);
    setResult(response);
  }
  async function revoke() {
    setPending(true);
    const response = await api.mutate(
      'identity',
      'affiliates.revokeShare',
      {},
      z.object({ token: z.string().uuid(), referrerId: z.string().uuid(), hits: z.number().int(), revokedAt: z.string() }),
    );
    setPending(false);
    setResult(response.ok ? null : response);
  }
  const link = result?.ok ? `${location.origin}/invite?token=${encodeURIComponent(result.data.token)}` : null;
  return (
    <Page
      title={copyText('accountroutes.promotions.and.invitations')}
      description={copyText('accountroutes.create.a.share.link.for.your.account')}
    >
      <div className="split">
        <Panel title={copyText('accountroutes.your.invitation.link')}>
          <div className="stack">
            {link ? (
              <>
                <label className="field">
                  <span>
                    <Text k="accountroutes.invitation.link" />
                  </span>
                  <input readOnly value={link} lang="zxx" aria-label={copyText('accountroutes.invitation.link')} />
                </label>
                <p className="muted">
                  <Text k="accountroutes.recorded.visits" />
                  {result?.ok ? result.data.hits : '—'}
                </p>
                <div className="actions">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void navigator.clipboard.writeText(link).then(
                        () => setCopy(copyText('accountroutes.copied.invitation.link')),
                        () => setCopy(copyText('accountroutes.copy.was.unavailable.select.the.link.above')),
                      )
                    }
                  >
                    <Text k="accountroutes.copy.link" />
                  </Button>
                  <Button variant="ghost" disabled={pending} onClick={() => void revoke()}>
                    <Text k="accountroutes.revoke.link" />
                  </Button>
                </div>
                <p role="status">{copy}</p>
              </>
            ) : (
              <>
                <p className="muted">
                  <Text k="accountroutes.create.the.current.idempotent.share.token.belonging" />
                </p>
                <Button disabled={pending || (result?.ok === false && result.reason === 'uncertain')} onClick={() => void create()}>
                  <Text k="accountroutes.create.invitation.link" />
                </Button>
              </>
            )}
            {result && !result.ok && (
              <div lang="und">
                <Failure result={result} />
              </div>
            )}
          </div>
        </Panel>
        <ReferralRecords />
      </div>
    </Page>
  );
}
