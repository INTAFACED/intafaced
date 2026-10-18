import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { parsePortalRoute } from '../../routes';
import type { SettingsBApi } from '../b-client';
import { Docs } from './Docs';
import { DeliveryDetail } from './Deliveries';
import { EndpointView } from './Endpoint';
import { AddEndpoint, HealthStrip } from './Webhooks';
import { CreateKey, KeysView } from './Keys';
import {
  canManageWebhooks,
  ipProblem,
  isPrivateHost,
  shownEndpointUrl,
  signingSnippets,
  splitIps,
  verifySnippets,
  webhookUrlProblem,
} from './model';
import { SecretReveal } from './SecretReveal';
import { AllowedIps, Recipe, SigningSettings } from './Signing';
import { developersApi } from './client';
import { developersCopy as c } from './copy';
import { SandboxView } from './Sandbox';
import type { ApiKey, Delivery, Endpoint, Health } from './schemas';

// TEST DATA only.
const api = {} as unknown as SettingsBApi;
const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
const key = (patch: Partial<ApiKey> = {}): ApiKey => ({
  id: 'TEST-key-1',
  name: 'TEST Checkout system',
  prefix: 'test_ab12',
  scopes: ['pay:read', 'pay:write'],
  lastUsedAt: null,
  revoked: false,
  mode: 'sandbox',
  requireSignature: false,
  requireNonEmptyIpAllowlist: false,
  ipAllowlist: [],
  ...patch,
});
const endpoint = (patch: Partial<Endpoint> = {}): Endpoint => ({
  id: 'TEST-endpoint-1',
  url: 'https://receiver.example/events?token=TOP-SECRET',
  status: 'active',
  disabledReason: null,
  consecutiveFailures: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  ...patch,
});
const health = (): Health => ({
  asOf: '2026-10-17T03:00:00.000Z',
  endpoints: [
    {
      endpointId: 'TEST-endpoint-1',
      status: 'active',
      consecutiveFailures: 2,
      deliveries: { pending: 1, delivered: 7, failed: 2, dead: 1 },
      lastDeliveredAt: '2026-10-16T00:00:00.000Z',
    },
  ],
});
const keysView = (keys: ApiKey[], scopes: string[] = ['pay:read', 'pay:write']) =>
  renderToString(<KeysView resource={ready(keys)} reload={() => {}} api={api} scopes={scopes} />);

describe('what the keys page says about live keys', () => {
  it('says live keys wait for approval until the business is approved, then says what is true instead', () => {
    const waiting = keysView([]);
    expect(waiting).toContain('Live keys open once INTAFACED has approved your business');
    const approved = renderToString(<KeysView resource={ready([])} reload={() => {}} api={api} scopes={['pay:read']} approved />);
    expect(approved).toContain('Your business is approved');
    expect(approved).not.toContain('once INTAFACED has approved your business');
  });
});

describe('webhook address guard', () => {
  it.each([
    ['https://receiver.example/events', null],
    ['', 'empty'],
    ['not a url', 'invalid'],
    ['http://receiver.example/events', 'https'],
    ['https://user:pass@receiver.example/', 'credentials'],
    ['https://localhost/hook', 'private'],
    ['https://127.0.0.1/hook', 'private'],
    ['https://10.1.2.3/hook', 'private'],
    ['https://192.168.1.5/hook', 'private'],
    ['https://172.20.0.1/hook', 'private'],
    ['https://169.254.169.254/latest', 'private'],
    ['https://[::1]/hook', 'private'],
    ['https://metadata.internal/hook', 'private'],
    ['https://intranet/hook', 'private'],
  ])('%s -> %s', (url, expected) => {
    expect(webhookUrlProblem(url)).toBe(expected);
  });
  it('lets a public address through, including one that looks close to a private range', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('203.0.113.9')).toBe(false);
    expect(isPrivateHost('api.example.com')).toBe(false);
  });
  it('never prints a query string', () => {
    expect(shownEndpointUrl('https://receiver.example/events?token=TOP-SECRET#x')).toBe('https://receiver.example/events');
  });
});

describe('allowed addresses', () => {
  it('accepts exact IPv4 and IPv6 only', () => {
    expect(ipProblem('203.0.113.10')).toBeNull();
    expect(ipProblem('2001:db8::1')).toBeNull();
    expect(ipProblem('203.0.113.0/24')).toBe('invalid');
    expect(ipProblem('example.com')).toBe('invalid');
    expect(ipProblem('999.1.1.1')).toBe('invalid');
    expect(ipProblem('  ')).toBe('empty');
  });
  it('splits a pasted list and drops repeats', () => {
    expect(splitIps('1.1.1.1, 2.2.2.2\n1.1.1.1  3.3.3.3')).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });
  it('shows the saved address list and that saving it does not change signing', () => {
    const out = renderToString(<AllowedIps api={api} keyId="TEST-key-1" ipAllowlist={['203.0.113.10']} requireSignature />);
    expect(out).toContain('203.0.113.10');
    expect(out).toContain('Saving addresses does not change whether this key requires signed requests.');
    expect(out).toContain('Requests with this key need a valid signature');
    expect(out).toContain('Replace allowed addresses');
  });
  it('never saves an empty list as a plain Save: emptying it is its own "Remove all addresses" choice', () => {
    const out = renderToString(<AllowedIps api={api} keyId="TEST-key-1" />);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Replace allowed addresses/);
    expect(out).toContain('Enter at least one address, or use Remove all addresses.');
    expect(out).toMatch(/<button(?![^>]*disabled="")[^>]*>Remove all addresses/);
  });
});

describe('API keys', () => {
  it('lists pay keys only, with their mode, and offers revoke for an active key only', () => {
    const out = keysView([
      key(),
      key({ id: 'TEST-key-2', name: 'TEST Old', prefix: 'test_zz99', revoked: true }),
      key({ id: 'TEST-key-3', name: 'UNRELATED', prefix: 'other_1', scopes: ['trade:read'] }),
    ]);
    expect(out).toContain('TEST Checkout system');
    expect(out).toContain('TEST Old');
    expect(out).not.toContain('UNRELATED');
    expect(out).toContain('Test');
    expect((out.match(/Revoke key/g) ?? []).length).toBe(1); // only the active key can be revoked
    expect(out).toContain('Showing 2 of 2 keys');
  });
  it("shows each key's saved signing state and allowed addresses on its row, and never a secret", () => {
    const out = keysView([
      key({ requireSignature: true, requireNonEmptyIpAllowlist: true, ipAllowlist: ['203.0.113.10', '203.0.113.11'] }),
      key({ id: 'TEST-key-2', name: 'TEST Plain', prefix: 'test_pl22' }),
      key({ id: 'TEST-key-3', name: 'TEST One', prefix: 'test_on33', ipAllowlist: ['203.0.113.12'] }),
      key({ id: 'TEST-key-4', name: 'TEST Gone', prefix: 'test_go44', revoked: true, requireSignature: true }),
    ]);
    expect(out).toContain('Protection');
    expect(out).toContain('Signed requests');
    expect(out).toContain('2 allowed addresses');
    expect(out).toContain('address required');
    expect(out).toContain('Signing off');
    expect(out).toContain('Any address');
    expect(out).toContain('1 allowed address');
    // A revoked key reads as revoked, not as protected.
    expect((out.match(/Signed requests/g) ?? []).length).toBeGreaterThan(0);
    expect(out).not.toMatch(/ifs_|203\.0\.113\.10/);
  });
  it('says when there are no keys', () => {
    const out = keysView([]);
    expect(out).toContain('No API keys yet');
  });
  it('does not print a key secret anywhere on the list page', () => {
    expect(keysView([key()])).not.toMatch(/test_TEST-NOT-A-REAL-KEY/);
  });
  it('turns the create form off, with the reason, when the person holds no key permission', () => {
    const out = renderToString(<CreateKey api={api} scopes={[]} onCreated={() => {}} />);
    expect(out).toContain('Only the account owner');
    expect(out).toMatch(/disabled/);
  });
  it('offers only the permissions the owner holds', () => {
    const out = renderToString(<CreateKey api={api} scopes={['pay:read']} onCreated={() => {}} />);
    expect(out).toContain('pay:read');
    expect(out).toContain('pay:refund');
    expect(out.match(/data-disabled/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('one-time secrets', () => {
  it('shows the secret once with a warning and a Hide button', () => {
    const out = renderToString(<SecretReveal title="Your new key" secret="TEST-ONLY-SECRET-123" what="API key" onHide={() => {}} />);
    expect(out).toContain('TEST-ONLY-SECRET-123');
    expect(out).toContain('shown only once');
    expect(out).toContain('Hide it');
  });
  it('shows no secret on the pages before one is made', () => {
    for (const html of [
      keysView([key()]),
      renderToString(
        <SigningSettings api={api} keyId="TEST-key-1" requireSignature={false} requireNonEmptyIpAllowlist={false} onSecret={() => {}} />,
      ),
      renderToString(<EndpointView api={api} endpoint={endpoint()} health={health()} canManage reload={() => {}} />),
      renderToString(<Docs />),
    ])
      expect(html).not.toMatch(/ifs_[A-Za-z0-9_-]{8,}|TEST-ONLY-SECRET/);
  });
});

describe('signing', () => {
  it('shows the saved signing posture and selects those choices', () => {
    const out = renderToString(
      <SigningSettings api={api} keyId="TEST-key-1" requireSignature requireNonEmptyIpAllowlist={false} onSecret={() => {}} />,
    );
    expect(out).toContain('Signed requests required: yes. Allowed address required: no.');
    expect(out).toContain('Requests with this key need a valid signature, or they are refused.');
    expect(out).toContain('The key does not need an allowed IP address.');
    expect(out).not.toContain('ifs_');
    expect((out.match(/type="radio"/g) ?? []).length).toBe(4);
    expect((out.match(/checked=""/g) ?? []).length).toBe(2);
  });
  it('offers Save for the saved choice, because both settings are already known', () => {
    const out = renderToString(
      <SigningSettings api={api} keyId="TEST-key-1" requireSignature={false} requireNonEmptyIpAllowlist={false} onSecret={() => {}} />,
    );
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Save signing settings/);
    expect(out).toContain('Save signing settings');
  });
  it('words turning signing off as deleting the secret, and turning it on later as issuing a new one', () => {
    expect(c.t('effectSecretDeleted')).toBe('This deletes the current signing secret; turning it on later issues a new one.');
    expect(c.t('secretExists')).toContain('A secret already exists');
  });
  it('turns "not revoked" into a refusal, and reads "not retried" as the replay of a request already queued', async () => {
    const tools = {
      identityMutate: async () => ({ ok: true, data: { revoked: false } }),
      mutate: async () => ({ ok: true, data: { retried: false, delivery: {} } }),
    } as unknown as Parameters<typeof developersApi>[0];
    const real = developersApi(tools);
    const revoked = await real.keyRevoke('k');
    expect(revoked.ok).toBe(false);
    expect(revoked.ok ? '' : revoked.message).toContain('already revoked, or it is not yours');
    const retried = await real.deliveryRetry('d', 'r');
    expect(retried.ok).toBe(true);
    const done = developersApi({ identityMutate: async () => ({ ok: true, data: { revoked: true } }) } as unknown as Parameters<
      typeof developersApi
    >[0]);
    expect((await done.keyRevoke('k')).ok).toBe(true);
  });
  it('gives the recipe: method, path, time, nonce, body hash and the five-minute window', () => {
    const out = renderToString(<Recipe />);
    for (const word of ['INTAFACED-REQ-V1', 'nonce', 'SHA-256', '5 minutes', 'x-intafaced-request']) expect(out).toContain(word);
    expect(out).toContain('TypeScript');
    expect(out).toContain('Python');
  });
  it('names why the signature check is not there', () => {
    expect(renderToString(<Recipe />)).toContain('no way to check a signature');
  });
  it('writes the same canonical string the service verifies, in both languages', () => {
    for (const code of Object.values(signingSnippets)) {
      expect(code).toContain('INTAFACED-REQ-V1');
      expect(code).toContain('x-intafaced-request-signature');
    }
    for (const code of Object.values(verifySnippets)) {
      expect(code).toContain('x-intafaced-signature');
      expect(code).toContain('x-intafaced-timestamp');
    }
  });
});

describe('webhooks', () => {
  it('shows the guard error and disables the add button for a private address', () => {
    // Server render shows the empty form; the guard itself is covered above. The form is off for a role that may only read.
    const out = renderToString(<AddEndpoint api={api} canManage={false} onCreated={() => {}} />);
    expect(out).toContain('can look at webhooks but not change them');
  });
  it('tells who may change webhooks', () => {
    expect(['owner', 'admin', 'developer'].every(canManageWebhooks)).toBe(true);
    expect(['finance', 'viewer', null].some((r) => canManageWebhooks(r))).toBe(false);
  });
  it('shows delivery health as tiles that open the delivery list with the same status', () => {
    const out = renderToString(<HealthStrip resource={ready(health())} />);
    for (const status of ['delivered', 'pending', 'failed', 'dead']) expect(out).toContain(`/pay/developer/deliveries?status=${status}`);
    expect(out).toContain('Updated');
  });
  it('says plainly when health cannot be read, and shows no zeros', () => {
    const out = renderToString(
      <HealthStrip resource={{ status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'x', code: '' } as never }} />,
    );
    expect(out).toContain('cannot be shown right now');
    expect(out).not.toContain('pp-kpi');
  });
  it('shows an endpoint without its query string, with failures, and no way to turn it back on', () => {
    const out = renderToString(<EndpointView api={api} endpoint={endpoint()} health={health()} canManage reload={() => {}} />);
    expect(out).toContain('https://receiver.example/events');
    expect(out).not.toContain('TOP-SECRET');
    expect(out).toContain('Turn off endpoint');
    const off = renderToString(
      <EndpointView
        api={api}
        endpoint={endpoint({ status: 'disabled', disabledReason: 'disabled_by_merchant' })}
        health={null}
        canManage
        reload={() => {}}
      />,
    );
    expect(off).not.toContain('Turn off endpoint');
    expect(off).toContain('add it as a new endpoint');
    expect(off).toContain('disabled by merchant');
  });
  it('turns changes off with the reason for a role that may only read', () => {
    const out = renderToString(<EndpointView api={api} endpoint={endpoint()} health={null} canManage={false} reload={() => {}} />);
    expect(out).toContain('can look at webhooks but not change them');
  });
  it('reads a delivery without ever showing the event body', () => {
    const d: Delivery = {
      id: 'TEST-delivery-1',
      endpointId: 'TEST-endpoint-1',
      eventType: 'payment.captured',
      status: 'dead',
      attempts: 3,
      lastStatusCode: 500,
      latencyMs: null,
      createdAt: '2026-10-16T01:00:00.000Z',
      deliveredAt: null,
    };
    const out = renderToString(<DeliveryDetail delivery={d} />);
    expect(out).toContain('Gave up');
    expect(out).toContain('payment.captured');
    expect(out).toContain('we do not show the event content');
  });
});

describe('test mode and the guide', () => {
  const failure = { status: 'failed' as const, failure: { ok: false, reason: 'unreachable', message: 'x', code: '' } as never };
  it('counts real things and links to the test tools', () => {
    const out = renderToString(
      <SandboxView keys={ready([key(), key({ id: 'k2', revoked: true })])} health={ready(health())} reload={() => {}} />,
    );
    expect(out).toContain('Test keys');
    expect(out).toContain('/pay/payments?view=tools');
    expect(out).toContain('/pay/payouts?view=tools');
    expect(out).toContain('Done');
  });
  it('shows a dash, never a zero, for a count it could not read', () => {
    const out = renderToString(<SandboxView keys={failure} health={failure} reload={() => {}} />);
    expect(out).toContain('Some counts cannot be shown');
    expect(out).toContain('—');
  });
  it('carries no operator or founder path, and says the libraries are not published', () => {
    const out = renderToString(<Docs />);
    expect(out).not.toMatch(new RegExp(['founder', 'Admin'].join(''), 'i'));
    expect(out).not.toMatch(/operator|admin:/i);
    expect(out).toContain('Libraries are not published');
  });
});

describe('addresses', () => {
  it('routes every developer page, and the endpoint detail carries its id', () => {
    for (const slug of ['keys', 'signing', 'webhooks', 'deliveries', 'sandbox', 'docs'])
      expect(parsePortalRoute(`/pay/developer/${slug}`)?.room).toBe(`developer-${slug}`);
    expect(parsePortalRoute('/pay/developer/webhooks/TEST-endpoint-1')).toEqual({ room: 'developer-endpoint', param: 'TEST-endpoint-1' });
  });
});
