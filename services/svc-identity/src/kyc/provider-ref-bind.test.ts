import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryKycDocumentStore } from './document-store.js';
import { bindProviderRefToDocument, ProviderRefBindError } from './provider-ref-bind.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Row = {
  id: string;
  user_id: string;
  status: string;
  provider_ref: string | null;
};

/**
 * Minimal tagged-template SQL stand-in for bind unit tests.
 * Covers SELECT FOR UPDATE + UPDATE RETURNING + transaction.begin shapes.
 */
function fakeSql(state: { records: Map<string, Row> }) {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('from kyc_records') && text.includes('for update')) {
      const id = String(values[0]);
      const row = state.records.get(id);
      return Promise.resolve(row ? [row] : []);
    }
    if (text.includes('update kyc_records')) {
      const documentId = String(values[0]);
      const recordId = String(values[1]);
      const row = state.records.get(recordId);
      if (!row || row.status !== 'pending' || row.provider_ref !== null) {
        return Promise.resolve([]);
      }
      row.provider_ref = documentId;
      return Promise.resolve([{ id: row.id }]);
    }
    if (text.includes('select provider_ref, status')) {
      const id = String(values[0]);
      const row = state.records.get(id);
      return Promise.resolve(row ? [{ provider_ref: row.provider_ref, status: row.status }] : []);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(run, {
    begin: async (_iso: string, fn: (tx: typeof run) => Promise<unknown>) => fn(run),
  }) as import('postgres').Sql;
  return sql;
}

function keyB64(): string {
  return randomBytes(32).toString('base64');
}

describe('bindProviderRefToDocument — opaque pointer only, ownership enforced', () => {
  it('binds document id when record pending and document owned by subject', async () => {
    const vault = new MemoryKycDocumentStore(keyB64());
    const doc = await vault.put({ userId: USER_A, contentType: 'image/jpeg', bytes: Buffer.from('scan') });
    const records = new Map<string, Row>([[REC, { id: REC, user_id: USER_A, status: 'pending', provider_ref: null }]]);
    const result = await bindProviderRefToDocument(fakeSql({ records }), vault, {
      recordId: REC,
      documentId: doc.id,
      operatorId: OP,
    });
    expect(result.providerRef).toBe(doc.id);
    expect(result.userId).toBe(USER_A);
    expect(result.document).not.toHaveProperty('bytes');
    expect(records.get(REC)!.provider_ref).toBe(doc.id);
  });

  it('refuses document owned by a different user (cross-user pointer)', async () => {
    const vault = new MemoryKycDocumentStore(keyB64());
    const foreign = await vault.put({ userId: USER_B, contentType: 'image/jpeg', bytes: Buffer.from('other') });
    const records = new Map<string, Row>([[REC, { id: REC, user_id: USER_A, status: 'pending', provider_ref: null }]]);
    await expect(
      bindProviderRefToDocument(fakeSql({ records }), vault, {
        recordId: REC,
        documentId: foreign.id,
        operatorId: OP,
      }),
    ).rejects.toMatchObject({ code: 'kyc_bind.doc_mismatch' });
    expect(records.get(REC)!.provider_ref).toBeNull();
  });

  it('refuses non-pending records', async () => {
    const vault = new MemoryKycDocumentStore(keyB64());
    const doc = await vault.put({ userId: USER_A, contentType: 'image/jpeg', bytes: Buffer.from('scan') });
    const records = new Map<string, Row>([[REC, { id: REC, user_id: USER_A, status: 'approved', provider_ref: null }]]);
    await expect(
      bindProviderRefToDocument(fakeSql({ records }), vault, {
        recordId: REC,
        documentId: doc.id,
        operatorId: OP,
      }),
    ).rejects.toBeInstanceOf(ProviderRefBindError);
    await expect(
      bindProviderRefToDocument(fakeSql({ records }), vault, {
        recordId: REC,
        documentId: doc.id,
        operatorId: OP,
      }),
    ).rejects.toMatchObject({ code: 'kyc_bind.record_not_pending' });
  });

  it('idempotent same pointer; refuses different second pointer', async () => {
    const vault = new MemoryKycDocumentStore(keyB64());
    const doc1 = await vault.put({ userId: USER_A, contentType: 'image/jpeg', bytes: Buffer.from('1') });
    const doc2 = await vault.put({ userId: USER_A, contentType: 'image/jpeg', bytes: Buffer.from('2') });
    const records = new Map<string, Row>([[REC, { id: REC, user_id: USER_A, status: 'pending', provider_ref: doc1.id }]]);
    const again = await bindProviderRefToDocument(fakeSql({ records }), vault, {
      recordId: REC,
      documentId: doc1.id,
      operatorId: OP,
    });
    expect(again.providerRef).toBe(doc1.id);

    await expect(
      bindProviderRefToDocument(fakeSql({ records }), vault, {
        recordId: REC,
        documentId: doc2.id,
        operatorId: OP,
      }),
    ).rejects.toMatchObject({ code: 'kyc_bind.already_set' });
  });
});
