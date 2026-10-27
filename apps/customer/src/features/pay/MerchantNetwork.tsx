import { useUnsavedForm } from './portal/useUnsavedForm';
import { extensionCopy } from './portal/extension-copy';
import { payCopy, PayCopy } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { Button, DataTable, ChoiceGroup as Tabs } from '@intafaced/ui';
import { Field } from './ui-kit';
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
        title={payCopy.t('subMerchantNetwork')}
        description={payCopy.t('theServiceResolvesYourOwnMerchantNode')}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setNode(merchantId);
              setOpened('');
            }}
          >
            <PayCopy k="returnToYourRoot" />
          </Button>
        }
      >
        <p className="pay-account-id">
          <PayCopy k="currentParent" /> {node}
        </p>
        <PayState resource={children.resource} retry={children.reload} empty={payCopy.t('noDirectChildrenReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('directSubMerchants')}
                headers={[
                  payCopy.t('merchantUser'),
                  payCopy.t('verification'),
                  payCopy.t('feeRate'),
                  payCopy.t('settlingParty'),
                  payCopy.t('state'),
                  '',
                ]}
              >
                {rows.map((child) => (
                  <tr key={child.id}>
                    <td>
                      {child.id}
                      <small className="pay-cell-note">{child.userId}</small>
                    </td>
                    <td>{child.kybStatus}</td>
                    <td>{child.feeBps === null ? payCopy.t('notPublished') : payCopy.t('bps', { feeBps: child.feeBps })}</td>
                    <td>{child.settlingParty}</td>
                    <td>
                      <Status value={child.status} />
                    </td>
                    <td>
                      <div className="actions">
                        <Button variant="ghost" onClick={() => setOpened(child.id)}>
                          <PayCopy k="details" />
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setNode(child.id);
                            setOpened('');
                          }}
                        >
                          <PayCopy k="children" />
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
      <PaySection title={payCopy.t('selectedMerchant')}>
        <PayState resource={record.resource} retry={record.reload}>
          {(data) => (
            <PayDetails
              values={[
                [payCopy.t('merchant'), data.id],
                [payCopy.t('user'), data.userId],
                [payCopy.t('parent'), data.parentMerchantId ?? payCopy.t('root')],
                [payCopy.t('depth'), String(data.depth)],
                [payCopy.t('acquiringMode'), data.mode],
                [payCopy.t('state'), data.status],
                [payCopy.t('businessVerification'), data.kybStatus],
                [payCopy.t('settlingParty'), data.settlingParty],
                [payCopy.t('feeRate'), data.feeBps === null ? payCopy.t('notPublished') : payCopy.t('bps', { feeBps: data.feeBps })],
              ]}
            />
          )}
        </PayState>
      </PaySection>
      <PaySection title={payCopy.t('onboardASubMerchant')} description={payCopy.t('createANewNodeUnderTheSelected')}>
        <div className="form-stack pay-form">
          <Field label={payCopy.t('accountIdToOnboard')} value={user} onChange={(event) => setUser(event.target.value)} maxLength={128} />
          <Field
            label={payCopy.t('agreedFeeRateBasisPoints')}
            inputMode="numeric"
            value={fee}
            onChange={(event) => setFee(event.target.value)}
            hint={payCopy.t('enterTheActualAgreedRateNoFee')}
          />
          <PayNotice title={payCopy.t('settlingParty')}>
            <PayCopy k="theCurrentContractSupportsSelfSettlementOnly" />
          </PayNotice>
          <ReviewedAction
            title={payCopy.t('createSubMerchant')}
            description={payCopy.t('createANewPayfacNodeForThe')}
            review={
              <PayDetails
                values={[
                  [payCopy.t('parent'), node],
                  [payCopy.t('account'), user],
                  [payCopy.t('fee'), payCopy.t('basisPoints2', { fee: fee })],
                  [payCopy.t('settlingParty'), payCopy.t('self')],
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
      <PaySection title={payCopy.t('permissionSubject')} description={payCopy.t('authorityOverASubjectMerchantIsChecked')}>
        <form
          data-testid="pay-filters"
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
            label={payCopy.t('subjectMerchantId')}
            value={subjectDraft}
            onChange={(event) => setSubjectDraft(event.target.value)}
            required
            pattern="[0-9a-fA-F-]{36}"
          />
          <Button type="submit" variant="secondary">
            <PayCopy k="readPermissions" />
          </Button>
        </form>
        <PayState resource={grants.resource} retry={grants.reload} empty={payCopy.t('noExplicitGrantsReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('permissionGrants')}
                headers={[payCopy.t('grantee'), payCopy.t('area'), payCopy.t('reason'), payCopy.t('grantedByAt')]}
              >
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
      <PaySection title={payCopy.t('changeADelegatedPermission')}>
        <div className="form-stack pay-form">
          <Field label={payCopy.t('granteeMerchantId')} value={grantee} onChange={(event) => setGrantee(event.target.value)} />
          <label className="field">
            <PayCopy k="permissionArea" />
            <select value={area} onChange={(event) => setArea(event.target.value)}>
              <option value="">{payCopy.t('chooseAnAreaReturnedByTheService')}</option>
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
            label={payCopy.t('reasonForThisChange')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={3}
            maxLength={500}
          />
          <div className="actions">
            {(['grant', 'revoke'] as const).map((action) => (
              <ReviewedAction
                key={action}
                title={action === 'grant' ? payCopy.t('grantPermission') : payCopy.t('revokePermission')}
                description={payCopy.t('theServiceChecksTheSubtreeAndAuthority')}
                review={
                  <PayDetails
                    values={[
                      [payCopy.t('grantee'), grantee],
                      [payCopy.t('subject'), subject],
                      [payCopy.t('area'), area],
                      [payCopy.t('reason'), reason],
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
      <PaySection title={payCopy.t('permissionHistory')}>
        <PayState resource={history.resource} retry={history.reload} empty={payCopy.t('noPermissionChangesReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('permissionJournal')}
                headers={[payCopy.t('sequenceAction'), payCopy.t('granteeArea'), payCopy.t('reason'), payCopy.t('actorTime')]}
              >
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
      <Tabs
        label={payCopy.t('developerSettings')}
        items={['Sandbox keys', 'Merchant webhooks']}
        labels={{ 'Sandbox keys': <PayCopy k="sandboxKeys" />, 'Merchant webhooks': <PayCopy k="merchantWebhooks" /> }}
        value={tab}
        onChange={setTab}
      />
      {tab === 'Sandbox keys' ? <SandboxKeys pay={pay} /> : <MerchantWebhooks pay={pay} />}
    </div>
  );
}
export function SandboxKeys({ pay, formOnly = false }: { pay: BusinessPayApi; formOnly?: boolean }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  useUnsavedForm(Boolean(name || scopes.length), extensionCopy.t('draftWarning'));
  const keys = useResource((signal) => pay.keys(signal), `pay:sandbox-keys:${pay.authority!.userId}`);
  const permitted = ['pay:read', 'pay:write', 'pay:refund'].filter((scope) => pay.authority!.scopes.includes(scope));
  return (
    <div className="stack">
      <PayNotice title={payCopy.t('sandboxCredentialsOnly')}>
        <PayCopy k="thisViewCreatesKeysWithAnExplicit" />
      </PayNotice>
      <PaySection title={payCopy.t('createASandboxPayKey')} description={payCopy.t('theseAreKeysOwnedByYourLogin')}>
        <div className="form-stack pay-form">
          <Field label={payCopy.t('keyName')} value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
          <fieldset className="pay-checkboxes">
            <legend>
              <PayCopy k="permissionsHeldByThisSession" />
            </legend>
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
            title={payCopy.t('createSandboxKey')}
            description={payCopy.t('createAnExplicitlySandboxCredentialWithOnly')}
            review={
              <PayDetails
                values={[
                  [payCopy.t('keyName'), name],
                  [payCopy.t('mode'), payCopy.t('sandbox')],
                  [payCopy.t('scopes'), scopes.join(', ')],
                ]}
              />
            }
            perform={() => pay.createSandboxKey(name.trim(), scopes)}
            disabled={!name.trim() || !scopes.length || Boolean(pay.guard.status(`${pay.authority!.userId}:sandbox-key-create`))}
            onConfirmed={(data) => {
              setSecret(data.key);
              setName('');
              setScopes([]);
              keys.reload();
            }}
          />
          {secret && (
            <PayNotice title={payCopy.t('sandboxSecretReturnedOnce')}>
              <code className="pay-secret">{secret}</code>
              <Button variant="secondary" onClick={() => setSecret('')}>
                <PayCopy k="hideSecret" />
              </Button>
            </PayNotice>
          )}
        </div>
      </PaySection>
      {!formOnly && (
        <PaySection title={payCopy.t('yourSandboxPayKeys')}>
          <PayState resource={keys.resource} retry={keys.reload} empty={payCopy.t('noKeysReturned')}>
            {(rows) => {
              const sandbox = rows.filter((key) => key.mode === 'sandbox' && key.scopes.some((scope) => scope.startsWith('pay:')));
              return (
                <>
                  {sandbox.length ? (
                    <DataTable
                      label={payCopy.t('sandboxPayKeys')}
                      headers={[payCopy.t('namePrefix'), payCopy.t('modeScopes'), payCopy.t('lastUsed'), payCopy.t('state'), '']}
                    >
                      {sandbox.map((key) => (
                        <tr key={key.id}>
                          <td>
                            {key.name}
                            <small className="pay-cell-note">{key.prefix}</small>
                          </td>
                          <td>
                            <PayCopy k="sandbox2" />
                            <small className="pay-cell-note">{key.scopes.join(', ')}</small>
                          </td>
                          <td>{key.lastUsedAt ?? payCopy.t('notUsed')}</td>
                          <td>{key.revoked ? payCopy.t('revoked') : payCopy.t('active')}</td>
                          <td>
                            {!key.revoked && (
                              <ReviewedAction
                                title={payCopy.t('revokeSandboxKey')}
                                description={payCopy.t('revokeThisSandboxCredentialExistingLiveKeys')}
                                perform={() => pay.revokeKey(key.id)}
                                onConfirmed={keys.reload}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                  ) : (
                    <p className="muted">
                      <PayCopy k="noSandboxPayKeysInTheReturned" />
                    </p>
                  )}
                  <PayPagination count={rows.length} limit={200} setLimit={() => {}} />
                </>
              );
            }}
          </PayState>
        </PaySection>
      )}
    </div>
  );
}
function MerchantWebhooks({ pay }: { pay: BusinessPayApi }) {
  const endpoints = useResource((signal) => pay.webhookEndpoints(signal), `pay:webhook-endpoints:${pay.authority!.merchantId}`);
  const deliveries = useResource((signal) => pay.webhookDeliveries(signal), `pay:webhook-deliveries:${pay.authority!.merchantId}`);
  return (
    <div className="stack">
      <PayNotice title={payCopy.t('merchantWebhookEnvironment')}>
        <PayCopy k="theWebhookContractHasNoSandboxEndpoint" />
      </PayNotice>
      <CreateWebhook pay={pay} reload={endpoints.reload} />
      <PaySection title={payCopy.t('merchantWebhookEndpoints')}>
        <PayState resource={endpoints.resource} retry={endpoints.reload} empty={payCopy.t('noWebhookEndpointsReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('webhookEndpoints')}
                headers={[payCopy.t('endpoint'), payCopy.t('state'), payCopy.t('failures'), payCopy.t('updated'), '']}
              >
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
      <PaySection title={payCopy.t('recordedWebhookDeliveries')}>
        <PayState resource={deliveries.resource} retry={deliveries.reload} empty={payCopy.t('noWebhookDeliveriesReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('webhookDeliveries')}
                headers={[
                  payCopy.t('eventEndpoint'),
                  payCopy.t('status'),
                  payCopy.t('attempts'),
                  payCopy.t('lastResponse'),
                  payCopy.t('nextAttempt'),
                ]}
              >
                {rows.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>
                      {delivery.eventType}
                      <small className="pay-cell-note">{delivery.endpointId}</small>
                    </td>
                    <td>{delivery.status}</td>
                    <td>{delivery.attempts}</td>
                    <td>
                      {delivery.lastStatusCode ?? payCopy.t('noResponse')}
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
export function CreateWebhook({ pay, reload }: { pay: BusinessPayApi; reload: () => void }) {
  const [url, setUrl] = useState('');
  useUnsavedForm(Boolean(url), extensionCopy.t('draftWarning'));
  const [idempotencyKey, setIdempotencyKey] = useState(() => `webhook-register:${crypto.randomUUID()}`);
  const [secret, setSecret] = useState('');
  return (
    <PaySection title={payCopy.t('registerAMerchantWebhook')} description={payCopy.t('configureAnActualReceiverASigningSecret')}>
      <div className="form-stack pay-form">
        <Field
          label={payCopy.t('webhookReceiverUrl')}
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          hint={payCopy.t('httpsIsRequiredExceptForALocal')}
        />
        <ReviewedAction
          title={payCopy.t('registerWebhook')}
          description={payCopy.t('registerThisReceiverForTheMerchantThis')}
          review={
            <PayDetails
              values={[
                [payCopy.t('receiver'), url],
                [payCopy.t('merchant'), pay.authority!.merchantId],
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
          <PayNotice title={payCopy.t('webhookSigningSecretReturnedOnce')}>
            <code className="pay-secret">{secret}</code>
            <Button variant="secondary" onClick={() => setSecret('')}>
              <PayCopy k="hideSigningSecret" />
            </Button>
          </PayNotice>
        )}
      </div>
    </PaySection>
  );
}
export function WebhookToggle({
  endpoint,
  pay,
  reload,
}: {
  endpoint: z.infer<typeof s.webhookSchema>;
  pay: BusinessPayApi;
  reload: () => void;
}) {
  const [key, setKey] = useState(() => `webhook-change:${endpoint.id}:${crypto.randomUUID()}`);
  const action = endpoint.status === 'active' ? 'disable' : 'enable';
  return (
    <ReviewedAction<unknown>
      title={action === 'disable' ? payCopy.t('disableReceiver') : payCopy.t('enableReceiver')}
      description={
        action === 'disable'
          ? payCopy.t('disableThisMerchantReceiverExistingDeliveryRecords')
          : payCopy.t('reEnableTheRepairedReceiverAndReset')
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
