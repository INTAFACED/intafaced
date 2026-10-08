import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Dialog, EmptyState, Failure, Field, Loading, Page, Panel, DataTable } from '../../shared/ui';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { enrollPasskey } from '../session/webauthn';
import { View } from './View';
import { customerRoomHref } from '../../app/navigation';
import './account.css';

const subAccountSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  purpose: z.string().nullable(),
  revoked: z.boolean(),
  createdAt: z.string(),
});
const passkeySchema = z.object({ credentialId: z.string(), createdAt: z.string(), transports: z.array(z.string()).optional() });
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
  const clean = path.split('?')[0];
  if (clean === '/view') return <View />;
  if (clean === '/uc/safe') return <Security />;
  if (clean === '/verification') return <Verification />;
  if (clean === '/notifications') return <Inbox />;
  if (clean === '/identbusiness')
    return (
      <Page title="Business verification">
        <EmptyState
          title="Verified company accounts are not connected"
          action={
            <a href="/verification" className="text-link">
              View personal verification ↗
            </a>
          }
        >
          Company identity, owner membership and the associated merchant permissions are not available through the current account service.
          Personal verification or a strategy subaccount cannot activate a Business account.
        </EmptyState>
      </Page>
    );
  if (clean?.startsWith('/uc/promotion') || clean === '/uc/invitingmining') return <Promotions />;
  if (clean === '/uc/paydividends')
    return (
      <Page title="Dividend records">
        <EmptyState title="Dividend history is not connected">
          There is no mounted owner-scoped dividend history contract. Token stake and earning activity remain available in their own rooms.
        </EmptyState>
        <div className="actions">
          <a className="text-link" href="/token">
            Open Token ↗
          </a>
          <a className="text-link" href="/bank/earn">
            Open Earn ↗
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
      The service confirmed the action.
    </p>
  ) : (
    <Failure result={result} />
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
    <Page title="Account" description="Your identity and strategy partitions. A strategy subaccount is not a Business account.">
      <div className="account-summary">
        <span className="eyebrow">PERSONAL ACCOUNT</span>
        <h2 className="numeric">{session?.userId}</h2>
        <div className="actions">
          <a className="text-link" href="/verification">
            Verification ↗
          </a>
          <a className="text-link" href="/uc/safe">
            Security ↗
          </a>
        </div>
      </div>
      <div className="split">
        <section className="stack">
          <div className="section-heading">
            <h2>Strategy subaccounts</h2>
            <Button variant="ghost" onClick={reload}>
              Refresh
            </Button>
          </div>
          {resource.status === 'loading' ? (
            <Loading />
          ) : resource.status === 'failed' ? (
            <Failure result={resource.failure} retry={reload} />
          ) : resource.data.length === 0 ? (
            <EmptyState title="No strategy subaccounts">Create a labelled partition for a strategy or fund.</EmptyState>
          ) : (
            <>
              <DataTable label="Your strategy subaccounts" headers={['Label', 'Purpose', 'Status', 'Action']}>
                {resource.data.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <strong>{account.label}</strong>
                      <small className="account-id numeric">{account.id}</small>
                    </td>
                    <td>{account.purpose ?? '—'}</td>
                    <td>{account.revoked ? 'Revoked' : 'Active'}</td>
                    <td>
                      <Button variant="ghost" disabled={account.revoked || pending} onClick={() => setRevoke(account)}>
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </DataTable>
              {resource.data.length === limit && (
                <div className="notice">
                  This is the returned window, not a complete account history.{' '}
                  {limit < 200 && (
                    <Button variant="ghost" onClick={() => setLimit(200)}>
                      Load up to 200
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
        <Panel title="Create a strategy subaccount">
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              setReview(true);
            }}
          >
            <Field
              label="Label"
              name="subaccount-label"
              required
              maxLength={64}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Field
              label="Purpose (optional)"
              name="subaccount-purpose"
              maxLength={200}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            />
            <Button type="submit" disabled={pending || (result?.ok === false && result.reason === 'uncertain')}>
              Review subaccount
            </Button>
          </form>
        </Panel>
      </div>
      <ResultNotice result={result} />
      {review && (
        <Dialog title="Create strategy subaccount" onClose={() => !pending && setReview(false)}>
          <div className="stack">
            <p>
              <strong>{label.trim()}</strong>
            </p>
            <p className="muted">{purpose.trim() || 'No purpose supplied.'}</p>
            <p className="muted">This creates a partition without moving funds. It does not open a verified company account.</p>
            <Button onClick={() => void create()} disabled={pending}>
              {pending ? 'Creating…' : 'Create subaccount'}
            </Button>
          </div>
        </Dialog>
      )}
      {revoke && (
        <Dialog title="Revoke strategy subaccount" onClose={() => !pending && setRevoke(null)}>
          <div className="stack">
            <p>
              Revoke <strong>{revoke.label}</strong>?
            </p>
            <p className="muted">The account is disabled. Its ledger balances are untouched.</p>
            <Button variant="danger" onClick={() => void retire()} disabled={pending}>
              Revoke subaccount
            </Button>
          </div>
        </Dialog>
      )}
    </Page>
  );
}
function Security() {
  const { api, session, clear } = useSession();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'webauthn.list', { limit: 50 }, z.array(passkeySchema), { signal }),
    `passkeys:${session?.userId}`,
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiResult<unknown> | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const [signOut, setSignOut] = useState(false);
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string; recoveryCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  async function enroll() {
    setPending(true);
    const response = await enrollPasskey(api);
    setPending(false);
    setResult(response);
    if (response.ok) reload();
  }
  async function removeKey() {
    if (!remove) return;
    setPending(true);
    const response = await api.mutate('identity', 'webauthn.remove', { credentialId: remove }, z.object({ removed: z.boolean() }));
    setPending(false);
    setResult(response);
    setRemove(null);
    if (response.ok) reload();
  }
  async function startTotp() {
    setPending(true);
    const response = await api.mutate(
      'identity',
      'totp.enrol',
      {},
      z.object({ secret: z.string(), uri: z.string(), recoveryCodes: z.array(z.string()) }),
    );
    setPending(false);
    setResult(response);
    if (response.ok) {
      setEnrollment(response.data);
      setConfirmed(false);
    }
  }
  async function confirmTotp(event: FormEvent) {
    event.preventDefault();
    if (!enrollment) return;
    setPending(true);
    const response = await api.mutate('identity', 'totp.confirm', { secret: enrollment.secret, code }, z.object({ ok: z.literal(true) }));
    setPending(false);
    setResult(response);
    if (response.ok) {
      setConfirmed(true);
      setCode('');
    }
  }
  async function revokeSessions() {
    setPending(true);
    const response = await api.mutate('identity', 'auth.logoutAll', {}, z.object({ revoked: z.number().int().nonnegative() }));
    setPending(false);
    setResult(response);
    setSignOut(false);
    if (response.ok) clear();
  }
  return (
    <Page title="Security" description="Passkeys, two-factor verification and signed-in sessions.">
      <div className="split">
        <section className="stack">
          <div className="section-heading">
            <h2>Passkeys</h2>
            <Button variant="secondary" disabled={pending} onClick={() => void enroll()}>
              Add passkey
            </Button>
          </div>
          {resource.status === 'loading' ? (
            <Loading />
          ) : resource.status === 'failed' ? (
            <Failure result={resource.failure} retry={reload} />
          ) : resource.data.length === 0 ? (
            <EmptyState title="No passkeys returned">Add a passkey to sign in using your device or security key.</EmptyState>
          ) : (
            <>
              <DataTable headers={['Credential', 'Added', 'Action']} label="Registered passkeys">
                {resource.data.map((key) => (
                  <tr key={key.credentialId}>
                    <td className="numeric">
                      {key.credentialId}
                      <small className="account-id">{key.transports?.join(', ') ?? 'Transport not published'}</small>
                    </td>
                    <td>{new Date(key.createdAt).toLocaleDateString()}</td>
                    <td>
                      <Button variant="ghost" disabled={pending} onClick={() => setRemove(key.credentialId)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </DataTable>
              {resource.data.length === 50 && <p className="muted">The service returned a 50-key window.</p>}
            </>
          )}
          <Panel title="Sessions">
            <p className="muted">
              Session refresh follows the identity service. Credentials stay in memory; reloading this app requires sign-in. A per-device
              session list is not mounted.
            </p>
            <Button variant="secondary" onClick={() => setSignOut(true)} disabled={pending}>
              Sign out everywhere
            </Button>
          </Panel>
        </section>
        <Panel title="Two-factor verification">
          <div className="form-stack">
            <p className="muted">
              Connect an authenticator and keep your recovery codes somewhere safe. No enabled status is assumed from an enrollment request.
            </p>
            {!enrollment ? (
              <Button variant="secondary" onClick={() => void startTotp()} disabled={pending}>
                Start authenticator setup
              </Button>
            ) : (
              <>
                <label className="field">
                  <span>Authenticator setup key</span>
                  <input readOnly value={enrollment.secret} aria-label="Authenticator setup key" autoComplete="off" />
                </label>
                <p className="muted">Add this key to your authenticator. The setup link can also be copied into a compatible app.</p>
                <details>
                  <summary>Setup URI</summary>
                  <code className="secret-wrap">{enrollment.uri}</code>
                </details>
                {!confirmed ? (
                  <form className="form-stack" onSubmit={(event) => void confirmTotp(event)}>
                    <Field
                      label="Six-digit authenticator code"
                      name="totp-confirm"
                      required
                      pattern="[0-9]{6}"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                    />
                    <Button type="submit" disabled={pending || (result?.ok === false && result.reason === 'uncertain')}>
                      Confirm authenticator
                    </Button>
                  </form>
                ) : (
                  <p className="notice" role="status">
                    Authenticator enrollment confirmed.
                  </p>
                )}
                <details open={confirmed}>
                  <summary>Recovery codes — save before leaving</summary>
                  <ul className="recovery-codes">
                    {enrollment.recoveryCodes.map((value) => (
                      <li key={value}>{value}</li>
                    ))}
                  </ul>
                </details>
              </>
            )}
          </div>
        </Panel>
      </div>
      <ResultNotice result={result} />
      {remove && (
        <Dialog title="Remove passkey" onClose={() => !pending && setRemove(null)}>
          <div className="stack">
            <p>Remove this authenticator from your account?</p>
            <p className="numeric muted">{remove}</p>
            <Button variant="danger" onClick={() => void removeKey()} disabled={pending}>
              Remove passkey
            </Button>
          </div>
        </Dialog>
      )}
      {signOut && (
        <Dialog title="Sign out everywhere" onClose={() => !pending && setSignOut(false)}>
          <div className="stack">
            <p>Revoke all current sessions, including this one?</p>
            <Button variant="danger" onClick={() => void revokeSessions()} disabled={pending}>
              Revoke all sessions
            </Button>
          </div>
        </Dialog>
      )}
    </Page>
  );
}
function Verification() {
  const { api, session } = useSession();
  const { resource, reload } = useResource(
    (signal) =>
      api.query(
        'identity',
        'kyc.status',
        { limit: 50 },
        z
          .object({ tier: z.enum(['none', 'basic', 'full', 'institutional']), records: z.array(kycRecord) })
          .refine((value) => value.records.every((record) => record.userId === session?.userId), 'Verification belongs to another account'),
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
    <Page title="Verification" description="See your current tier and request review. Submitting a request does not grant verification.">
      <div className="split">
        <section className="stack">
          {resource.status === 'loading' ? (
            <Loading />
          ) : resource.status === 'failed' ? (
            <Failure result={resource.failure} retry={reload} />
          ) : (
            <>
              <div className="account-summary">
                <span className="eyebrow">CURRENT VERIFIED TIER</span>
                <h2>{resource.data.tier}</h2>
              </div>
              {resource.data.records.length ? (
                <DataTable headers={['Requested tier', 'Country', 'Status', 'Requested']} label="Verification requests">
                  {resource.data.records.map((record) => (
                    <tr key={record.id}>
                      <td>{record.tier}</td>
                      <td>{record.jurisdiction}</td>
                      <td>{record.status}</td>
                      <td>{new Date(record.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <EmptyState title="No verification requests returned">Request the tier needed for your account.</EmptyState>
              )}
              <p className="muted">Up to 50 requests. Document uploads and provider review are not connected through this request form.</p>
            </>
          )}
        </section>
        <Panel title="Request verification">
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              setReview(true);
            }}
          >
            <label className="field">
              <span>Requested tier</span>
              <select value={tier} onChange={(event) => setTier(event.target.value)}>
                <option value="basic">Basic</option>
                <option value="full">Full</option>
                <option value="institutional">Institutional</option>
              </select>
            </label>
            <Field
              label="Country code"
              name="kyc-country"
              required
              minLength={2}
              maxLength={2}
              pattern="[a-zA-Z]{2}"
              value={country}
              onChange={(event) => setCountry(event.target.value)}
              hint="ISO two-letter jurisdiction code."
            />
            <Button type="submit" disabled={pending || (result?.ok === false && result.reason === 'uncertain')}>
              Review request
            </Button>
          </form>
        </Panel>
      </div>
      <ResultNotice result={result} />
      {review && (
        <Dialog title="Request verification review" onClose={() => !pending && setReview(false)}>
          <div className="stack">
            <p>
              {tier} · {country.toUpperCase()}
            </p>
            <p className="muted">This creates a pending request. Your current verified tier remains authoritative.</p>
            <Button disabled={pending} onClick={() => void request()}>
              Submit request
            </Button>
          </div>
        </Dialog>
      )}
    </Page>
  );
}
const notification = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  titleKey: z.string(),
  bodyKey: z.string(),
  title: z.string(),
  body: z.string(),
  href: z.string().nullable(),
  severity: z.enum(['info', 'action', 'critical']),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
function Inbox() {
  const { api, session } = useSession();
  const [cursor, setCursor] = useState<string | undefined>();
  const [unread, setUnread] = useState(false);
  const { resource, reload } = useResource(
    (signal) =>
      api.query(
        'notify',
        'notify.list',
        { limit: 50, ...(cursor ? { cursor } : {}), unreadOnly: unread },
        z
          .object({ items: z.array(notification), nextCursor: z.string().uuid().nullable() })
          .refine((value) => value.items.every((item) => item.userId === session?.userId), 'Inbox belongs to another account'),
        { signal },
      ),
    `notifications:${session?.userId}:${cursor}:${unread}`,
  );
  const [result, setResult] = useState<ApiResult<unknown> | null>(null);
  async function mark(id: string) {
    const response = await api.mutate('notify', 'notify.markRead', { ids: [id] }, z.object({ marked: z.number().int().nonnegative() }));
    setResult(response);
    if (response.ok) reload();
  }
  return (
    <Page
      title="Inbox"
      description="Private account notifications. Public notices are a separate surface."
      actions={
        <Button
          variant="secondary"
          onClick={() => {
            setUnread(!unread);
            setCursor(undefined);
          }}
        >
          {unread ? 'Show all' : 'Unread only'}
        </Button>
      }
    >
      <ResultNotice result={result} />
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : resource.data.items.length === 0 ? (
        <EmptyState title="No notifications returned">New account notifications will appear here when delivered.</EmptyState>
      ) : (
        <div className="notification-list">
          {resource.data.items.map((item) => (
            <article key={item.id} className={item.readAt ? 'read' : ''}>
              <div>
                <span className="badge">{item.severity}</span>
                <time>{new Date(item.createdAt).toLocaleString()}</time>
              </div>
              <h2>{item.title === item.titleKey ? 'Notification text is unavailable' : item.title}</h2>
              <p>
                {item.body === item.bodyKey
                  ? 'This notification’s details are not published. Open its related room for current information.'
                  : item.body}
              </p>
              <div className="actions">
                {customerRoomHref(item.href) && (
                  <a className="text-link" href={customerRoomHref(item.href)}>
                    Open related room ↗
                  </a>
                )}
                {!item.readAt && (
                  <Button variant="ghost" onClick={() => void mark(item.id)}>
                    Mark read
                  </Button>
                )}
              </div>
            </article>
          ))}
          {resource.data.nextCursor && (
            <Button variant="secondary" onClick={() => setCursor(resource.data.nextCursor ?? undefined)}>
              Next page
            </Button>
          )}
          {cursor && (
            <Button variant="ghost" onClick={() => setCursor(undefined)}>
              Back to latest
            </Button>
          )}
        </div>
      )}
    </Page>
  );
}
function Promotions() {
  const { api, session } = useSession();
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
      title="Promotions and invitations"
      description="Create a share link for your account. Referral attribution follows the identity service."
    >
      <div className="split">
        <Panel title="Your invitation link">
          <div className="stack">
            {link ? (
              <>
                <label className="field">
                  <span>Invitation link</span>
                  <input readOnly value={link} aria-label="Invitation link" />
                </label>
                <p className="muted">Recorded visits: {result?.ok ? result.data.hits : '—'}</p>
                <div className="actions">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void navigator.clipboard.writeText(link).then(
                        () => setCopy('Copied invitation link.'),
                        () => setCopy('Copy was unavailable; select the link above.'),
                      )
                    }
                  >
                    Copy link
                  </Button>
                  <Button variant="ghost" disabled={pending} onClick={() => void revoke()}>
                    Revoke link
                  </Button>
                </div>
                <p role="status">{copy}</p>
              </>
            ) : (
              <>
                <p className="muted">Create the current idempotent share token belonging to your account.</p>
                <Button disabled={pending || (result?.ok === false && result.reason === 'uncertain')} onClick={() => void create()}>
                  Create invitation link
                </Button>
              </>
            )}
            {result && !result.ok && <Failure result={result} />}
          </div>
        </Panel>
        <section className="stack">
          <h2>Referral records</h2>
          <p className="muted">
            Your account ID: <span className="numeric">{session?.userId}</span>
          </p>
          <div className="notice">
            A customer referral tree, commission balance and promotion-card history are not mounted. No reward total or payout is inferred
            from a visit count.
          </div>
        </section>
      </div>
    </Page>
  );
}
