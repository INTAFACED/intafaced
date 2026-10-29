import { describe, expect, it } from 'vitest';
import { hostDispatchView, readHostDispatch } from './host-dispatch';

const served = (role: string, host: string) => ({ role, host, result: 'served', buildId: 'abc' });
const json = (body: unknown, status = 200, type = 'application/json') =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

describe('host dispatch receipt', () => {
  it('shows three served hosts from a served receipt', () => {
    const view = hostDispatchView({
      schemaVersion: 1,
      checkedAt: '2026-10-29T10:00:00.000Z',
      status: 'served',
      hosts: [served('apex', 'https://a.test'), served('app', 'https://b.test'), served('join', 'https://c.test')],
    });
    expect(view.source).toBe('receipt');
    expect(view.rows.map((row) => [row.role, row.host, row.result])).toEqual([
      ['apex', 'https://a.test', 'served'],
      ['app', 'https://b.test', 'served'],
      ['join', 'https://c.test', 'served'],
    ]);
  });

  it('names the host a refusal is for, and its typed code', () => {
    const view = hostDispatchView({
      schemaVersion: 1,
      checkedAt: '2026-10-29T10:00:00.000Z',
      status: 'refused',
      hosts: [
        { role: 'apex', host: 'https://a.test', result: 'host.not_served', detail: 'ECONNREFUSED' },
        served('app', 'https://b.test'),
        { role: 'join', host: 'https://c.test', result: 'host.join_wrong_build' },
      ],
      lastGood: { checkedAt: '2026-10-28T10:00:00.000Z', staleSince: '2026-10-29T10:00:00.000Z' },
    });
    expect(view.rows[0]).toEqual({ role: 'apex', host: 'https://a.test', result: 'host.not_served', detail: 'ECONNREFUSED' });
    expect(view.rows[2]?.result).toBe('host.join_wrong_build');
    expect(view.lastGood).toEqual({ checkedAt: '2026-10-28T10:00:00.000Z', staleSince: '2026-10-29T10:00:00.000Z' });
  });

  it('applies a refusal for every host to each role, and a host the receipt leaves out is not checked', () => {
    const all = hostDispatchView({
      schemaVersion: 1,
      checkedAt: '2026-10-29T10:00:00.000Z',
      hosts: [{ role: 'all', host: null, result: 'host.tls_verification_disabled' }],
    });
    expect(all.rows.map((row) => row.result)).toEqual(Array(3).fill('host.tls_verification_disabled'));
    const partial = hostDispatchView({
      schemaVersion: 1,
      checkedAt: '2026-10-29T10:00:00.000Z',
      hosts: [served('apex', 'https://a.test')],
    });
    expect(partial.rows.map((row) => row.result)).toEqual(['served', 'host.not_checked', 'host.not_checked']);
  });

  it('refuses a body that is not a version-1 receipt', () => {
    for (const body of [
      null,
      [],
      { schemaVersion: 2, checkedAt: 'x', hosts: [] },
      { schemaVersion: 1, hosts: [] },
      { schemaVersion: 1, checkedAt: 'x' },
    ]) {
      const view = hostDispatchView(body);
      expect(view.source).toBe('host.receipt_invalid');
      expect(view.rows.map((row) => row.result)).toEqual(Array(3).fill('host.receipt_invalid'));
    }
  });

  it('reads no receipt from a missing file or the app index a static host answers with', async () => {
    expect((await readHostDispatch(json({}, 404))).source).toBe('host.receipt_missing');
    expect((await readHostDispatch(json('<html>', 200, 'text/html'))).source).toBe('host.receipt_missing');
    const failing = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect((await readHostDispatch(failing)).source).toBe('host.receipt_unreadable');
    const broken = (async () => new Response('{', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    expect((await readHostDispatch(broken)).source).toBe('host.receipt_invalid');
  });
});
