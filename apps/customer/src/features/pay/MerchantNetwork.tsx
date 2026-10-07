import { useState } from 'react';
import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field, Tabs } from '../../shared/ui';
import type { BusinessPayApi } from './pay-api';
import { PayDetails, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status } from './components';
import { validatedMutation } from './BusinessPay';
import * as s from './schemas';

export function MerchantNetwork({ pay }: { pay: BusinessPayApi }) {
  const merchantId = pay.authority!.merchantId;
  const [node, setNode] = useState(merchantId);
  const [limit, setLimit] = useState(50);
  const [user, setUser] = useState('');
  const [fee, setFee] = useState('');
  const [opened, setOpened] = useState('');
  const children = useResource(
    (signal) => pay.query('submerchant.list', { merchantId: node, limit }, z.array(s.submerchantSchema), signal),
    `pay:network:${merchantId}:${node}:${limit}`,
  );
  const record = useResource(
    (signal) => pay.query('submerchant.get', { merchantId: opened || node }, s.submerchantSchema, signal),
    `pay:network-node:${merchantId}:${opened || node}`,
  );
  return (
    <div className="stack">
      <PaySection
        title="Sub-merchant network"
        description="The service resolves your own merchant node and enforces its subtree. Trading subaccounts are not companies."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setNode(merchantId);
              setOpened('');
            }}
          >
            Return to your root
          </Button>
        }
      >
        <p className="pay-account-id">Current parent: {node}</p>
        <PayState resource={children.resource} retry={children.reload} empty="No direct children returned">
          {(rows) => (
            <>
              <DataTable
                label="Direct sub-merchants"
                headers={['Merchant / user', 'Verification', 'Fee rate', 'Settling party', 'State', '']}
              >
                {rows.map((child) => (
                  <tr key={child.id}>
                    <td>
                      {child.id}
                      <small className="pay-cell-note">{child.userId}</small>
                    </td>
                    <td>{child.kybStatus}</td>
                    <td>{child.feeBps === null ? 'Not published' : `${child.feeBps} bps`}</td>
                    <td>{child.settlingParty}</td>
                    <td>
                      <Status value={child.status} />
                    </td>
                    <td>
                      <div className="actions">
                        <Button variant="ghost" onClick={() => setOpened(child.id)}>
                          Details
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setNode(child.id);
                            setOpened('');
                          }}
                        >
                          Children
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
      <PaySection title="Selected merchant">
        <PayState resource={record.resource} retry={record.reload}>
          {(data) => (
            <PayDetails
              values={[
                ['Merchant', data.id],
                ['User', data.userId],
                ['Parent', data.parentMerchantId ?? 'Root'],
                ['Depth', String(data.depth)],
                ['Acquiring mode', data.mode],
                ['State', data.status],
                ['Business verification', data.kybStatus],
                ['Settling party', data.settlingParty],
                ['Fee rate', data.feeBps === null ? 'Not published' : `${data.feeBps} bps`],
              ]}
            />
          )}
        </PayState>
      </PaySection>
      <PaySection
        title="Onboard a sub-merchant"
        description="Create a new node under the selected parent. An existing merchant cannot be adopted into your tree."
      >
        <div className="form-stack pay-form">
          <Field label="Account ID to onboard" value={user} onChange={(event) => setUser(event.target.value)} maxLength={128} />
          <Field
            label="Agreed fee rate · basis points"
            inputMode="numeric"
            value={fee}
            onChange={(event) => setFee(event.target.value)}
            hint="Enter the actual agreed rate. No fee is prefilled."
          />
          <PayNotice title="Settling party">
            The current contract supports self settlement only. Sponsored settlement is unavailable.
          </PayNotice>
          <ReviewedAction
            title="Create sub-merchant"
            description="Create a new payfac node for the named account under this parent with its supplied fee rate. The backend verifies subtree and onboarding authority."
            review={
              <PayDetails
                values={[
                  ['Parent', node],
                  ['Account', user],
                  ['Fee', `${fee} basis points`],
                  ['Settling party', 'self'],
                ]}
              />
            }
            perform={() =>
              validatedMutation(
                pay,
                'submerchant.create',
                { parentMerchantId: node, userId: user, pricing: { feeBps: fee === '' ? undefined : Number(fee) }, settlingParty: 'self' },
                z.object({
                  parentMerchantId: s.id,
                  userId: z.string().min(1).max(128),
                  pricing: z.object({ feeBps: z.number().int().min(0).max(10_000) }),
                  settlingParty: z.literal('self'),
                }),
                s.submerchantSchema,
                'pay:write',
                'submerchant-create',
              )
            }
            disabled={!user || fee === '' || Boolean(pay.access('pay:write'))}
            onConfirmed={() => {
              setUser('');
              setFee('');
              children.reload();
            }}
          />
        </div>
      </PaySection>
    </div>
  );
}
export function MerchantPermissions({ pay }: { pay: BusinessPayApi }) {
  const merchantId = pay.authority!.merchantId;
  const [subjectDraft, setSubjectDraft] = useState(merchantId);
  const [subject, setSubject] = useState(merchantId);
  const [grantee, setGrantee] = useState('');
  const [area, setArea] = useState('');
  const [reason, setReason] = useState('');
  const [limit, setLimit] = useState(50);
  const areas = useResource(
    (signal) => pay.query('submerchantPermission.areas', undefined, z.array(z.string()), signal),
    `pay:permission-areas:${merchantId}`,
  );
  const grants = useResource(
    (signal) => pay.query('submerchantPermission.list', { subjectMerchantId: subject, limit }, z.array(s.grantSchema), signal),
    `pay:permission-grants:${merchantId}:${subject}:${limit}`,
  );
  const history = useResource(
    (signal) => pay.query('submerchantPermission.history', { subjectMerchantId: subject, limit }, z.array(s.permissionEventSchema), signal),
    `pay:permission-history:${merchantId}:${subject}:${limit}`,
  );
  function refresh() {
    grants.reload();
    history.reload();
  }
  const input = { granteeMerchantId: grantee, subjectMerchantId: subject, area, reason: reason.trim() };
  const allowedArea = areas.resource.status === 'ready' && areas.resource.data.includes(area);
  return (
    <div className="stack">
      <PaySection
        title="Permission subject"
        description="Authority over a subject merchant is checked by the service; implicit ownership is not a listed grant."
      >
        <form
          className="pay-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (s.id.safeParse(subjectDraft).success) {
              setSubject(subjectDraft);
              setGrantee('');
              setArea('');
              setReason('');
            }
          }}
        >
          <Field
            label="Subject merchant ID"
            value={subjectDraft}
            onChange={(event) => setSubjectDraft(event.target.value)}
            required
            pattern="[0-9a-fA-F-]{36}"
          />
          <Button type="submit" variant="secondary">
            Read permissions
          </Button>
        </form>
        <PayState resource={grants.resource} retry={grants.reload} empty="No explicit grants returned">
          {(rows) => (
            <>
              <DataTable label="Permission grants" headers={['Grantee', 'Area', 'Reason', 'Granted by / at']}>
                {rows.map((grant) => (
                  <tr key={`${grant.granteeMerchantId}:${grant.area}`}>
                    <td>{grant.granteeMerchantId}</td>
                    <td>{grant.area}</td>
                    <td>{grant.reason}</td>
                    <td>
                      {grant.actorId}
                      <small className="pay-cell-note">{grant.grantedAt}</small>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
      <PaySection title="Change a delegated permission">
        <div className="form-stack pay-form">
          <Field label="Grantee merchant ID" value={grantee} onChange={(event) => setGrantee(event.target.value)} />
          <label className="field">
            Permission area
            <select value={area} onChange={(event) => setArea(event.target.value)}>
              <option value="">Choose an area returned by the service</option>
              {areas.resource.status === 'ready' &&
                areas.resource.data.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
            </select>
          </label>
          <PayState resource={areas.resource} retry={areas.reload}>
            {() => null}
          </PayState>
          <Field
            label="Reason for this change"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={3}
            maxLength={500}
          />
          <div className="actions">
            {(['grant', 'revoke'] as const).map((action) => (
              <ReviewedAction
                key={action}
                title={`${action === 'grant' ? 'Grant' : 'Revoke'} permission`}
                description="The service checks the subtree and authority you already hold. Every change appends an attributed journal record; it cannot create platform scopes."
                review={
                  <PayDetails
                    values={[
                      ['Grantee', grantee],
                      ['Subject', subject],
                      ['Area', area],
                      ['Reason', reason],
                    ]}
                  />
                }
                perform={() =>
                  validatedMutation(
                    pay,
                    `submerchantPermission.${action}`,
                    input,
                    z.object({
                      granteeMerchantId: s.id,
                      subjectMerchantId: s.id,
                      area: z.string().min(1),
                      reason: z.string().trim().min(3).max(500),
                    }),
                    s.permissionEventSchema,
                    'pay:write',
                    `permission:${subject}:${grantee}:${area}`,
                  )
                }
                disabled={!s.id.safeParse(grantee).success || !allowedArea || reason.trim().length < 3 || Boolean(pay.access('pay:write'))}
                onConfirmed={refresh}
              />
            ))}
          </div>
        </div>
      </PaySection>
      <PaySection title="Permission history">
        <PayState resource={history.resource} retry={history.reload} empty="No permission changes returned">
          {(rows) => (
            <>
              <DataTable label="Permission journal" headers={['Sequence / action', 'Grantee / area', 'Reason', 'Actor / time']}>
                {rows.map((event) => (
                  <tr key={event.id}>
                    <td>
                      {event.seq} · {event.action}
                    </td>
                    <td>
                      {event.granteeMerchantId}
                      <small className="pay-cell-note">{event.area}</small>
                    </td>
                    <td>{event.reason}</td>
                    <td>
                      {event.actorId}
                      <small className="pay-cell-note">{event.createdAt}</small>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
export function MerchantDeveloper({ pay }: { pay: BusinessPayApi }) {
  const [tab, setTab] = useState('Sandbox keys');
  return (
    <div className="stack">
      <Tabs label="Developer settings" items={['Sandbox keys', 'Merchant webhooks']} value={tab} onChange={setTab} />
      {tab === 'Sandbox keys' ? <SandboxKeys pay={pay} /> : <MerchantWebhooks pay={pay} />}
    </div>
  );
}
function SandboxKeys({ pay }: { pay: BusinessPayApi }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  const keys = useResource((signal) => pay.keys(signal), `pay:sandbox-keys:${pay.authority!.userId}`);
  const permitted = ['pay:read', 'pay:write', 'pay:refund'].filter((scope) => pay.authority!.scopes.includes(scope));
  return (
    <div className="stack">
      <PayNotice title="Sandbox credentials only">
        This view creates keys with an explicit sandbox mode. It never exchanges a sandbox key into your live session, and has no payment,
        capture, refund or payout controls. Sandbox mode cannot be omitted from key creation.
      </PayNotice>
      <PaySection
        title="Create a sandbox Pay key"
        description="These are keys owned by your login. A key is not a separate verified company identity."
      >
        <div className="form-stack pay-form">
          <Field label="Key name" value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
          <fieldset className="pay-checkboxes">
            <legend>Permissions held by this session</legend>
            {permitted.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter((value) => value !== scope))}
                />
                {scope}
              </label>
            ))}
          </fieldset>
          <ReviewedAction
            title="Create sandbox key"
            description="Create an explicitly sandbox credential with only the selected held Pay scopes. The secret is returned once and remains only in this view."
            review={
              <PayDetails
                values={[
                  ['Key name', name],
                  ['Mode', 'sandbox'],
                  ['Scopes', scopes.join(', ')],
                ]}
              />
            }
            perform={() => pay.createSandboxKey(name.trim(), scopes)}
            disabled={!name.trim() || !scopes.length || Boolean(pay.guard.status(`${pay.authority!.userId}:sandbox-key-create`))}
            onConfirmed={(data) => {
              setSecret(data.key);
              keys.reload();
            }}
          />
          {secret && (
            <PayNotice title="Sandbox secret returned once">
              <code className="pay-secret">{secret}</code>
              <Button variant="secondary" onClick={() => setSecret('')}>
                Hide secret
              </Button>
            </PayNotice>
          )}
        </div>
      </PaySection>
      <PaySection title="Your sandbox Pay keys">
        <PayState resource={keys.resource} retry={keys.reload} empty="No keys returned">
          {(rows) => {
            const sandbox = rows.filter((key) => key.mode === 'sandbox' && key.scopes.some((scope) => scope.startsWith('pay:')));
            return (
              <>
                {sandbox.length ? (
                  <DataTable label="Sandbox Pay keys" headers={['Name / prefix', 'Mode / scopes', 'Last used', 'State', '']}>
                    {sandbox.map((key) => (
                      <tr key={key.id}>
                        <td>
                          {key.name}
                          <small className="pay-cell-note">{key.prefix}</small>
                        </td>
                        <td>
                          Sandbox<small className="pay-cell-note">{key.scopes.join(', ')}</small>
                        </td>
                        <td>{key.lastUsedAt ?? 'Not used'}</td>
                        <td>{key.revoked ? 'Revoked' : 'Active'}</td>
                        <td>
                          {!key.revoked && (
                            <ReviewedAction
                              title="Revoke sandbox key"
                              description="Revoke this sandbox credential. Existing live keys are not changed by this action."
                              perform={() => pay.revokeKey(key.id)}
                              onConfirmed={keys.reload}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                ) : (
                  <p className="muted">No sandbox Pay keys in the returned window.</p>
                )}
                <PayPagination count={rows.length} limit={200} setLimit={() => {}} />
              </>
            );
          }}
        </PayState>
      </PaySection>
    </div>
  );
}
function MerchantWebhooks({ pay }: { pay: BusinessPayApi }) {
  const endpoints = useResource((signal) => pay.webhookEndpoints(signal), `pay:webhook-endpoints:${pay.authority!.merchantId}`);
  const deliveries = useResource((signal) => pay.webhookDeliveries(signal), `pay:webhook-deliveries:${pay.authority!.merchantId}`);
  return (
    <div className="stack">
      <PayNotice title="Merchant webhook environment">
        The webhook contract has no sandbox endpoint mode or test delivery action. These are actual merchant endpoints and recorded
        deliveries; this view never simulates a successful test. Endpoint changes affect merchant delivery configuration.
      </PayNotice>
      <CreateWebhook pay={pay} reload={endpoints.reload} />
      <PaySection title="Merchant webhook endpoints">
        <PayState resource={endpoints.resource} retry={endpoints.reload} empty="No webhook endpoints returned">
          {(rows) => (
            <>
              <DataTable label="Webhook endpoints" headers={['Endpoint', 'State', 'Failures', 'Updated', '']}>
                {rows.map((endpoint) => (
                  <tr key={endpoint.id}>
                    <td>{endpoint.url}</td>
                    <td>
                      {endpoint.status}
                      <small className="pay-cell-note">{endpoint.disabledReason ?? ''}</small>
                    </td>
                    <td>{endpoint.consecutiveFailures}</td>
                    <td>{endpoint.updatedAt}</td>
                    <td>
                      <WebhookToggle key={endpoint.id} endpoint={endpoint} pay={pay} reload={endpoints.reload} />
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={200} setLimit={() => {}} />
            </>
          )}
        </PayState>
      </PaySection>
      <PaySection title="Recorded webhook deliveries">
        <PayState resource={deliveries.resource} retry={deliveries.reload} empty="No webhook deliveries returned">
          {(rows) => (
            <>
              <DataTable label="Webhook deliveries" headers={['Event / endpoint', 'Status', 'Attempts', 'Last response', 'Next attempt']}>
                {rows.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>
                      {delivery.eventType}
                      <small className="pay-cell-note">{delivery.endpointId}</small>
                    </td>
                    <td>{delivery.status}</td>
                    <td>{delivery.attempts}</td>
                    <td>
                      {delivery.lastStatusCode ?? 'No response'}
                      <small className="pay-cell-note">{delivery.lastError ?? ''}</small>
                    </td>
                    <td>{delivery.nextAttemptAt}</td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={200} setLimit={() => {}} />
            </>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
function CreateWebhook({ pay, reload }: { pay: BusinessPayApi; reload: () => void }) {
  const [url, setUrl] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => `webhook-register:${crypto.randomUUID()}`);
  const [secret, setSecret] = useState('');
  return (
    <PaySection
      title="Register a merchant webhook"
      description="Configure an actual receiver. A signing secret is returned once; it is never saved by this page."
    >
      <div className="form-stack pay-form">
        <Field
          label="Webhook receiver URL"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          hint="HTTPS is required except for a local development receiver."
        />
        <ReviewedAction
          title="Register webhook"
          description="Register this receiver for the merchant. This is merchant configuration, not a sandbox delivery test. Verify your receiver before enabling it for real event delivery."
          review={
            <PayDetails
              values={[
                ['Receiver', url],
                ['Merchant', pay.authority!.merchantId],
              ]}
            />
          }
          perform={() => pay.registerWebhook(url, idempotencyKey)}
          disabled={!url || Boolean(pay.access('pay:write')) || Boolean(pay.guard.status(`${pay.authority!.userId}:webhook-create`))}
          onConfirmed={(data) => {
            setSecret(data.secret);
            setUrl('');
            setIdempotencyKey(`webhook-register:${crypto.randomUUID()}`);
            reload();
          }}
        />
        {secret && (
          <PayNotice title="Webhook signing secret returned once">
            <code className="pay-secret">{secret}</code>
            <Button variant="secondary" onClick={() => setSecret('')}>
              Hide signing secret
            </Button>
          </PayNotice>
        )}
      </div>
    </PaySection>
  );
}
function WebhookToggle({ endpoint, pay, reload }: { endpoint: z.infer<typeof s.webhookSchema>; pay: BusinessPayApi; reload: () => void }) {
  const [key, setKey] = useState(() => `webhook-change:${endpoint.id}:${crypto.randomUUID()}`);
  const action = endpoint.status === 'active' ? 'disable' : 'enable';
  return (
    <ReviewedAction<unknown>
      title={action === 'disable' ? 'Disable receiver' : 'Enable receiver'}
      description={
        action === 'disable'
          ? 'Disable this merchant receiver. Existing delivery records remain visible.'
          : 'Re-enable the repaired receiver and reset its failure counter. This does not send a fabricated test event.'
      }
      review={<p>{endpoint.url}</p>}
      perform={() => pay.manageWebhook(endpoint.id, action, key)}
      disabled={Boolean(pay.access('pay:write')) || Boolean(pay.guard.status(`${pay.authority!.userId}:webhook:${endpoint.id}`))}
      onConfirmed={() => {
        setKey(`webhook-change:${endpoint.id}:${crypto.randomUUID()}`);
        reload();
      }}
    />
  );
}
