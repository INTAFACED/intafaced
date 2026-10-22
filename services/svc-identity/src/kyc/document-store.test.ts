import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertDocAccess, KycDocumentError, MemoryKycDocumentStore } from './document-store.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function keyB64(): string {
  return randomBytes(32).toString('base64');
}

describe('PII access control — no free cross-user document read', () => {
  it('assertDocAccess: owner mismatch is not_found (no oracle)', () => {
    expect(() => assertDocAccess(USER_A, { kind: 'owner', userId: USER_B })).toThrow(KycDocumentError);
    try {
      assertDocAccess(USER_A, { kind: 'owner', userId: USER_B });
    } catch (e) {
      expect((e as KycDocumentError).code).toBe('kyc_doc.not_found');
    }
  });

  it('assertDocAccess: compliance may open any subject row', () => {
    expect(() => assertDocAccess(USER_A, { kind: 'compliance', operatorId: OP })).not.toThrow();
  });

  it('assertDocAccess: blank principal is reader_missing', () => {
    expect(() => assertDocAccess(USER_A, { kind: 'owner', userId: '' })).toThrow(/principal/i);
  });

  it('records storedBy on meta for compliance audit — never on the subject by default', async () => {
    const store = new MemoryKycDocumentStore(keyB64());
    const meta = await store.put({
      userId: USER_A,
      contentType: 'image/jpeg',
      bytes: Buffer.from('scan'),
      storedBy: OP,
    });
    expect(meta.storedBy).toBe(OP);
    expect(meta.userId).toBe(USER_A);
    expect(meta.storedBy).not.toBe(USER_A);
  });

  it('owner can decrypt own bytes; foreign owner cannot', async () => {
    const store = new MemoryKycDocumentStore(keyB64());
    const plain = Buffer.from('passport-scan-user-a');
    const meta = await store.put({ userId: USER_A, contentType: 'image/jpeg', bytes: plain });

    const own = await store.getFor(meta.id, { kind: 'owner', userId: USER_A });
    expect(own.bytes.equals(plain)).toBe(true);
    expect(own.meta.userId).toBe(USER_A);

    await expect(store.getFor(meta.id, { kind: 'owner', userId: USER_B })).rejects.toMatchObject({
      code: 'kyc_doc.not_found',
    });
  });

  it('compliance can decrypt any subject; missing id is not_found', async () => {
    const store = new MemoryKycDocumentStore(keyB64());
    const plain = Buffer.from('id-card-bytes');
    const meta = await store.put({ userId: USER_A, contentType: 'application/pdf', bytes: plain });

    const opened = await store.getFor(meta.id, { kind: 'compliance', operatorId: OP });
    expect(opened.bytes.equals(plain)).toBe(true);

    await expect(store.getFor('00000000-0000-4000-8000-000000000000', { kind: 'compliance', operatorId: OP })).rejects.toMatchObject({
      code: 'kyc_doc.not_found',
    });
  });

  it('listMetaForUser returns meta only for that user — no foreign rows, no bytes field', async () => {
    const store = new MemoryKycDocumentStore(keyB64());
    await store.put({ userId: USER_A, contentType: 'image/png', bytes: Buffer.from('a1') });
    await store.put({ userId: USER_A, contentType: 'image/png', bytes: Buffer.from('a2') });
    await store.put({ userId: USER_B, contentType: 'image/png', bytes: Buffer.from('b1') });

    const listA = await store.listMetaForUser(USER_A);
    expect(listA).toHaveLength(2);
    expect(listA.every((m) => m.userId === USER_A)).toBe(true);
    for (const m of listA) {
      expect(m).not.toHaveProperty('bytes');
      expect(m).not.toHaveProperty('ciphertext');
      expect(typeof m.byteLength).toBe('number');
    }
    expect(await store.listMetaForUser(USER_B)).toHaveLength(1);
  });

  it('deleteFor: owner cannot delete foreign; compliance can', async () => {
    const store = new MemoryKycDocumentStore(keyB64());
    const meta = await store.put({ userId: USER_A, contentType: 'image/png', bytes: Buffer.from('x') });

    await expect(store.deleteFor(meta.id, { kind: 'owner', userId: USER_B })).rejects.toMatchObject({
      code: 'kyc_doc.not_found',
    });
    // still there for owner
    expect((await store.getFor(meta.id, { kind: 'owner', userId: USER_A })).meta.id).toBe(meta.id);

    expect(await store.deleteFor(meta.id, { kind: 'compliance', operatorId: OP })).toBe(true);
    await expect(store.getFor(meta.id, { kind: 'compliance', operatorId: OP })).rejects.toMatchObject({
      code: 'kyc_doc.not_found',
    });
  });

  it('assertDocumentForUser refuses foreign ownership (provider_ref bind gate)', async () => {
    const store = new MemoryKycDocumentStore(keyB64());
    const meta = await store.put({ userId: USER_A, contentType: 'image/png', bytes: Buffer.from('bind-me') });

    await expect(store.assertDocumentForUser(meta.id, USER_A)).resolves.toMatchObject({ id: meta.id, userId: USER_A });
    await expect(store.assertDocumentForUser(meta.id, USER_B)).rejects.toMatchObject({ code: 'kyc_doc.not_found' });
  });

  it('refuses put without a real key — no improvised encryption', async () => {
    const store = new MemoryKycDocumentStore('');
    await expect(store.put({ userId: USER_A, contentType: 'image/png', bytes: Buffer.from('x') })).rejects.toMatchObject({
      code: 'kyc_doc.key_missing',
    });
  });

  it('blank key refuses put before content-type — no invented key', async () => {
    const store = new MemoryKycDocumentStore('');
    await expect(store.put({ userId: USER_A, contentType: '', bytes: Buffer.from('x') })).rejects.toMatchObject({
      code: 'kyc_doc.key_missing',
    });
    await expect(store.put({ userId: USER_A, contentType: 'image/png', bytes: Buffer.alloc(0) })).rejects.toMatchObject({
      code: 'kyc_doc.key_missing',
    });
  });

  it('blank key refuses get before reader — no invented key', async () => {
    const store = new MemoryKycDocumentStore('');
    await expect(store.getFor('00000000-0000-4000-8000-000000000000', { kind: 'compliance', operatorId: OP })).rejects.toMatchObject({
      code: 'kyc_doc.key_missing',
    });
    await expect(store.getFor('00000000-0000-4000-8000-000000000000', { kind: 'owner', userId: '' })).rejects.toMatchObject({
      code: 'kyc_doc.key_missing',
    });
  });

  it('vault surface has no free get(id) / delete(id) — only principal-bound methods', () => {
    const store = new MemoryKycDocumentStore(keyB64()) as unknown as Record<string, unknown>;
    expect(typeof store.get).toBe('undefined');
    expect(typeof store.delete).toBe('undefined');
    expect(typeof store.getFor).toBe('function');
    expect(typeof store.deleteFor).toBe('function');
  });
});
