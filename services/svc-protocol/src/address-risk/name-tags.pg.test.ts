import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresTrustDeskStore } from './trust-desk.pg.js';
import { approveNameTag, readNameTags, requestNameTag } from './trust-desk.js';

/** Public name tags (20261114150000) on a real test database: a proof on file and two approvers. Deletes only this file's rows. */
// CI provides the database; this test runs unconditionally and fails where none answers.
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '20261029070000_protocol_listing_ownership.sql',
  '20261031001738_protocol_listing_chain_identity.sql',
  '20261107073648_protocol_address_risk.sql',
  '20261114150000_protocol_name_tags.sql',
].map((f) => join(here, '..', '..', 'drizzle', f));
if (!(await postgresAvailable(URL))) throw new Error('postgres unavailable');
const db = createDb({ url: URL, schema: 'protocol', max: 4 }, {});
const sql: Sql = db.sql;
const CHAIN_ID = 991_140;
const PROVEN = '0x000000000000000000000000000000000000Ab07';
const UNPROVEN = '0x000000000000000000000000000000000000ab08';
const SIGNER = '0x00000000000000000000000000000000000051C7';
const NONCE = 'test-name-tag-nonce-991140';
const A = 'founder-a';
const B = 'founder-b';

describe('name tags (Postgres)', () => {
  const store = new PostgresTrustDeskStore(sql);
  const cleanup = async () => {
    await sql`DELETE FROM protocol.name_tag_requests WHERE chain_id = ${CHAIN_ID}`;
    await sql`DELETE FROM protocol.address_label_history WHERE label_id IN (SELECT id FROM protocol.address_labels WHERE chain_id = ${CHAIN_ID})`;
    await sql`DELETE FROM protocol.address_labels WHERE chain_id = ${CHAIN_ID}`;
    await sql`DELETE FROM protocol.listing_ownership_proofs WHERE nonce = ${NONCE}`;
    await sql`DELETE FROM protocol.listing_challenges WHERE nonce = ${NONCE}`;
  };
  beforeAll(async () => {
    await assertTestDatabase(sql, 'svc-protocol name-tags.pg.test');
    await sql`CREATE SCHEMA IF NOT EXISTS protocol`;
    for (const m of MIGRATIONS) await sql.unsafe(readFileSync(m, 'utf8'));
    await cleanup();
    // The proven address's owner signed a challenge: what listing.verifyOwnership stores (checksummed token).
    await sql`
      INSERT INTO protocol.listing_challenges (nonce, chain_id, token, message, issued_at, expires_at, used_at)
      VALUES (${NONCE}, ${CHAIN_ID}, ${PROVEN}, 'TEST challenge', now(), now() + interval '5 minutes', now())`;
    await sql`
      INSERT INTO protocol.listing_ownership_proofs (nonce, chain_id, token, signer, message_hash, signature, block_number)
      VALUES (${NONCE}, ${CHAIN_ID}, ${PROVEN}, ${SIGNER}, '0xhash', '0xsig', 42)`;
  });
  afterAll(async () => {
    await cleanup();
    await db.close();
  });

  it('a tag with no proof of ownership on file cannot be approved', async () => {
    const asked = await requestNameTag(store, {
      chainId: CHAIN_ID,
      address: UNPROVEN,
      tag: 'TEST unproven',
      reason: 'TEST',
      requesterId: A,
    });
    expect(asked).toMatchObject({ address: UNPROVEN, status: 'pending', proof: null, approvals: [] });
    await expect(approveNameTag(store, { chainId: CHAIN_ID, requestId: asked.id, approverId: A })).rejects.toMatchObject({
      code: 'protocol.nametags.no_proof',
    });
    await expect(approveNameTag(store, { chainId: CHAIN_ID, requestId: asked.id, approverId: B })).rejects.toMatchObject({
      code: 'protocol.nametags.no_proof',
    });
    expect((await readNameTags(store, CHAIN_ID, new Date())).requests.find((r) => r.id === asked.id)).toMatchObject({
      status: 'pending',
      approvals: [],
    });
  });

  it('a proven tag is public only after two different approvers, as the address name label', async () => {
    const asked = await requestNameTag(store, {
      chainId: CHAIN_ID,
      address: PROVEN,
      tag: 'TEST proven',
      reason: 'TEST owner signed',
      requesterId: A,
    });
    expect(asked.address).toBe(PROVEN.toLowerCase());
    expect(asked.proof).toMatchObject({ signer: SIGNER, blockNumber: '42' });
    await expect(
      requestNameTag(store, { chainId: CHAIN_ID, address: PROVEN, tag: 'TEST other', reason: 'TEST', requesterId: B }),
    ).rejects.toMatchObject({ code: 'protocol.nametags.request_pending' });
    const first = await approveNameTag(store, { chainId: CHAIN_ID, requestId: asked.id, approverId: A });
    expect(first).toMatchObject({ status: 'pending', approvals: [{ approverId: A }] });
    await expect(approveNameTag(store, { chainId: CHAIN_ID, requestId: asked.id, approverId: A })).rejects.toMatchObject({
      code: 'protocol.nametags.same_approver',
    });
    // The table refuses the same person twice, and a public tag with no proof, even if the service did not.
    await expect(
      sql`UPDATE protocol.name_tag_requests SET status = 'public', second_approver_id = ${A}, proof_nonce = ${NONCE}, published_at = now() WHERE id = ${asked.id}`,
    ).rejects.toThrow(/four_eyes/);
    await expect(
      sql`UPDATE protocol.name_tag_requests SET status = 'public', second_approver_id = ${B}, published_at = now() WHERE id = ${asked.id}`,
    ).rejects.toThrow(/public/);
    expect(await sql`SELECT 1 FROM protocol.address_labels WHERE chain_id = ${CHAIN_ID}`).toHaveLength(0);
    // Two second approvals at once publish once.
    const results = await Promise.allSettled([
      approveNameTag(store, { chainId: CHAIN_ID, requestId: asked.id, approverId: B }),
      approveNameTag(store, { chainId: CHAIN_ID, requestId: asked.id, approverId: 'founder-c' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const read = (await readNameTags(store, CHAIN_ID, new Date())).requests.find((r) => r.id === asked.id)!;
    expect(read).toMatchObject({ status: 'public', proof: { signer: SIGNER } });
    expect(read.approvals.map((a) => a.approverId)[0]).toBe(A);
    expect(read.approvals).toHaveLength(2);
    expect(read.publishedAt).not.toBeNull();
    const labels = await sql<{ kind: string; value: string; source: string; reputation: string; reason: string }[]>`
      SELECT kind, value, source, reputation, reason FROM protocol.address_labels WHERE chain_id = ${CHAIN_ID}`;
    expect(labels).toEqual([
      { kind: 'name', value: 'TEST proven', source: 'owner_proof', reputation: 'UNKNOWN', reason: 'TEST owner signed' },
    ]);
    await expect(approveNameTag(store, { chainId: CHAIN_ID, requestId: asked.id, approverId: 'founder-d' })).rejects.toMatchObject({
      code: 'protocol.nametags.request_unknown',
    });
  });
});
