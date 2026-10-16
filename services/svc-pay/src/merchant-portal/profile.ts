import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { MerchantAreaFence } from '../merchant-ownership.js';
import { assertMerchantAreaAccess, merchantNotFound } from '../merchant-ownership.js';
import { allowMerchantRead } from '../merchant-read-access.js';
import type { MerchantTeamRead } from '../merchant-team-read.js';
import { PayError, type PayService } from '../payment-service.js';
import { decodeListCursor, encodeListCursor } from '../list-page.js';
import { PortalError } from './errors.js';
import {
  applyPatch,
  hashesMatch,
  parseProfilePatch,
  profileChangeHash,
  sensitiveKeysOf,
  type ProfileFields,
  type SensitiveKey,
} from './fields.js';
import { requirePageLimit } from './series-cursor.js';

type PayLookup = Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>;

interface StoredRow {
  id: string;
  profile_version: string;
  display_name: string | null;
  legal_name: string | null;
  website: string | null;
  support_email: string | null;
  support_phone: string | null;
  statement_descriptor: string | null;
  industry: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  address_country: string | null;
}

const COLUMNS = `
  id, profile_version::text AS profile_version, display_name, legal_name, website, support_email, support_phone,
  statement_descriptor, industry, address_line1, address_line2, address_city, address_region,
  address_postal_code, address_country
`;

function addressOf(row: StoredRow): ProfileFields['address'] {
  if (row.address_line1 === null) return null;
  return {
    line1: row.address_line1,
    line2: row.address_line2,
    city: row.address_city ?? '',
    region: row.address_region,
    postalCode: row.address_postal_code ?? '',
    country: row.address_country ?? '',
  };
}

function fieldsOf(row: StoredRow): ProfileFields {
  return {
    displayName: row.display_name,
    legalName: row.legal_name,
    address: addressOf(row),
    website: row.website,
    supportEmail: row.support_email,
    supportPhone: row.support_phone,
    statementDescriptor: row.statement_descriptor,
    industry: row.industry,
  };
}

function profileOf(row: StoredRow) {
  return { merchantId: row.id, version: row.profile_version, ...fieldsOf(row) };
}

function versionOf(raw: string): bigint {
  if (!/^\d{1,18}$/.test(raw)) throw new PortalError('pay.profile_version_invalid', 'bad_request');
  return BigInt(raw);
}

export class MerchantProfileService {
  constructor(
    private readonly sql: Sql,
    private readonly pay: PayLookup,
    private readonly trees: MerchantAreaFence | null,
    private readonly team: MerchantTeamRead,
  ) {}

  async get(userId: string | undefined, merchantId: string) {
    await this.readFence(userId, merchantId);
    const row = await this.load(this.sql, merchantId);
    return profileOf(row);
  }

  async history(userId: string | undefined, input: { merchantId: string; limit?: number; cursor?: string }) {
    await this.readFence(userId, input.merchantId);
    const limit = requirePageLimit(input.limit, 'pay.profile_history_limit_unset');
    const cursor = input.cursor === undefined ? null : decodeListCursor(input.cursor);
    const rows = await this.sql<
      Array<{
        request_id: string;
        seq: string;
        status: 'applied' | 'pending' | 'rejected' | 'conflict';
        before_profile: ProfileFields;
        after_profile: ProfileFields;
        sensitive_keys: SensitiveKey[];
        change_hash: string;
        expected_version: string;
        maker_id: string;
        checker_id: string | null;
        reason: string;
        checker_reason: string | null;
        created_at: Date;
        decided_at: Date | null;
        cursor_ts: string;
      }>
    >`
      SELECT request_id, seq::text AS seq, status, before_profile, after_profile, sensitive_keys,
             change_hash, expected_version::text AS expected_version, maker_id, checker_id, reason, checker_reason,
             created_at, decided_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
        FROM pay.merchant_profile_changes
       WHERE merchant_id = ${input.merchantId}
         ${
           cursor
             ? this.sql`AND (created_at, request_id) < ((${cursor.createdAtCursor}::text)::timestamptz, ${cursor.id}::uuid)`
             : this.sql``
         }
       ORDER BY created_at DESC, request_id DESC
       LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    return {
      items: kept.map((row) => ({
        requestId: row.request_id,
        seq: row.seq,
        status: row.status,
        before: row.before_profile,
        after: row.after_profile,
        sensitiveKeys: row.sensitive_keys,
        changeHash: row.change_hash,
        expectedVersion: row.expected_version,
        makerId: row.maker_id,
        checkerId: row.checker_id,
        reason: row.reason,
        checkerReason: row.checker_reason,
        createdAt: row.created_at.toISOString(),
        decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
      })),
      nextCursor: hasMore && last ? encodeListCursor(last.cursor_ts, last.request_id) : null,
    };
  }

  async submit(
    userId: string,
    input: {
      merchantId: string;
      expectedVersion: string;
      reason: string;
      displayName?: string | null;
      legalName?: string | null;
      address?: ProfileFields['address'];
      website?: string | null;
      supportEmail?: string | null;
      supportPhone?: string | null;
      statementDescriptor?: string | null;
      industry?: string | null;
    },
  ) {
    await this.manageFence(userId, input.merchantId);
    const { immediate, sensitive } = parseProfilePatch(input);
    const expected = versionOf(input.expectedVersion);
    const sensitiveKeys = sensitiveKeysOf(sensitive);
    const requestId = randomUUID();
    return transaction(
      this.sql,
      async (tx) => {
        const current = await this.lock(tx, input.merchantId);
        if (BigInt(current.profile_version) !== expected) throw new PortalError('pay.profile_version_conflict', 'conflict');
        const pending = await tx<Array<{ id: string }>>`
        SELECT request_id AS id FROM pay.merchant_profile_changes
         WHERE merchant_id = ${input.merchantId} AND status = 'pending' LIMIT 1`;
        if (pending[0]) throw new PortalError('pay.profile_change_pending', 'conflict');
        const before = fieldsOf(current);
        let version = current.profile_version;
        let live = before;
        if (Object.keys(immediate).length > 0) {
          live = applyPatch(before, immediate);
          version = await this.writeFields(tx, input.merchantId, live, expected);
        }
        const after = applyPatch(live, sensitive);
        const hash = profileChangeHash(sensitive, version);
        const appliedNow = sensitiveKeys.length === 0;
        await tx`
        INSERT INTO pay.merchant_profile_changes (
          request_id, merchant_id, status, before_profile, after_profile, sensitive_keys,
          change_hash, expected_version, maker_id, reason, decided_at
        ) VALUES (
          ${requestId}, ${input.merchantId}, ${appliedNow ? 'applied' : 'pending'},
          ${tx.json(before as never)}, ${tx.json(after as never)}, ${tx.json(sensitiveKeys as never)},
          ${hash}, ${version}::bigint, ${userId}, ${input.reason},
          ${appliedNow ? new Date() : null}
        )`;
        const stored = await this.load(tx, input.merchantId);
        return {
          requestId,
          outcome: appliedNow ? ('applied' as const) : ('pending_second_approval' as const),
          version: stored.profile_version,
          changeHash: appliedNow ? null : hash,
          profile: profileOf(stored),
        };
      },
      { isolation: 'read committed' },
    );
  }

  async decide(
    userId: string,
    input: {
      merchantId: string;
      requestId: string;
      decision: 'confirm' | 'reject' | 'withdraw';
      expectedChangeHash: string;
      reason: string;
    },
  ) {
    await this.manageFence(userId, input.merchantId);
    return transaction(
      this.sql,
      async (tx) => {
        await this.lock(tx, input.merchantId);
        const rows = await tx<
          Array<{
            maker_id: string;
            status: string;
            change_hash: string;
            expected_version: string;
            after_profile: ProfileFields;
            sensitive_keys: SensitiveKey[];
          }>
        >`
        SELECT maker_id, status, change_hash, expected_version::text AS expected_version, after_profile, sensitive_keys
          FROM pay.merchant_profile_changes
         WHERE request_id = ${input.requestId} AND merchant_id = ${input.merchantId}
         FOR UPDATE`;
        const row = rows[0];
        if (!row) throw new PortalError('pay.profile_change_not_found', 'not_found');
        if (row.status !== 'pending') throw new PortalError('pay.profile_change_not_pending', 'conflict');
        if (!hashesMatch(row.change_hash, input.expectedChangeHash)) throw new PortalError('pay.change_hash_mismatch', 'conflict');
        const maker = row.maker_id === userId;
        if (maker && input.decision !== 'withdraw') throw new PortalError('pay.profile_self_approval', 'forbidden');
        if (!maker && input.decision === 'withdraw') throw new PortalError('pay.profile_withdraw_forbidden', 'forbidden');
        if (input.decision === 'confirm') {
          const current = await this.load(tx, input.merchantId);
          if (current.profile_version !== row.expected_version) throw new PortalError('pay.profile_version_conflict', 'conflict');
          const next = applyPatch(fieldsOf(current), pickSensitive(row.after_profile, row.sensitive_keys));
          await this.writeFields(tx, input.merchantId, next, BigInt(current.profile_version));
        }
        await tx`
        UPDATE pay.merchant_profile_changes
           SET status = ${input.decision === 'confirm' ? 'applied' : 'rejected'},
               checker_id = ${maker ? null : userId},
               checker_reason = ${input.reason},
               decided_at = now()
         WHERE request_id = ${input.requestId}`;
        const stored = await this.load(tx, input.merchantId);
        return {
          requestId: input.requestId,
          outcome: input.decision === 'confirm' ? ('applied' as const) : ('rejected' as const),
          version: stored.profile_version,
          profile: profileOf(stored),
        };
      },
      { isolation: 'read committed' },
    );
  }

  private async readFence(userId: string | undefined, merchantId: string) {
    await allowMerchantRead({
      ownerCheck: () => assertMerchantAreaAccess(this.pay, userId, merchantId, 'merchant.profile', this.trees),
      team: this.team,
      userId,
      merchantId,
      permission: 'profile.read',
    });
  }

  /** Owner, or an active admin of this merchant. A PayFac parent is not a writer. Missing and foreign are one refusal. */
  private async manageFence(userId: string, merchantId: string): Promise<void> {
    const [merchant, role] = await Promise.all([
      this.pay.getMerchant(merchantId).then(
        (row) => row,
        (err: unknown) => {
          if (err instanceof PayError && err.code === 'pay.merchant_not_found') return null;
          throw err;
        },
      ),
      this.team.activeRole(userId, merchantId),
    ]);
    if (merchant && merchant.userId === userId) return;
    if (role === 'admin') return;
    if (role) throw new PortalError('pay.team_role_forbidden', 'forbidden');
    throw merchantNotFound(merchantId);
  }

  private async load(sql: Sql, merchantId: string): Promise<StoredRow> {
    const rows = await sql<StoredRow[]>`SELECT ${sql.unsafe(COLUMNS)} FROM pay.merchants WHERE id = ${merchantId}`;
    const row = rows[0];
    if (!row) throw merchantNotFound(merchantId);
    return row;
  }

  private async lock(sql: Sql, merchantId: string): Promise<StoredRow> {
    const rows = await sql<StoredRow[]>`SELECT ${sql.unsafe(COLUMNS)} FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw merchantNotFound(merchantId);
    return row;
  }

  private async writeFields(sql: Sql, merchantId: string, fields: ProfileFields, expectedVersion: bigint): Promise<string> {
    const address = fields.address;
    const rows = await sql<Array<{ profile_version: string }>>`
      UPDATE pay.merchants SET
        display_name = ${fields.displayName},
        legal_name = ${fields.legalName},
        website = ${fields.website},
        support_email = ${fields.supportEmail},
        support_phone = ${fields.supportPhone},
        statement_descriptor = ${fields.statementDescriptor},
        industry = ${fields.industry},
        address_line1 = ${address ? address.line1 : null},
        address_line2 = ${address ? address.line2 : null},
        address_city = ${address ? address.city : null},
        address_region = ${address ? address.region : null},
        address_postal_code = ${address ? address.postalCode : null},
        address_country = ${address ? address.country : null},
        profile_version = profile_version + 1,
        updated_at = now()
       WHERE id = ${merchantId} AND profile_version = ${expectedVersion.toString()}::bigint
       RETURNING profile_version::text AS profile_version`;
    const row = rows[0];
    if (!row) throw new PortalError('pay.profile_version_conflict', 'conflict');
    return row.profile_version;
  }
}

function pickSensitive(after: ProfileFields, keys: SensitiveKey[]): Partial<ProfileFields> {
  const patch: Partial<ProfileFields> = {};
  for (const key of keys) {
    if (key === 'legalName') patch.legalName = after.legalName;
    else if (key === 'address') patch.address = after.address;
    else if (key === 'statementDescriptor') patch.statementDescriptor = after.statementDescriptor;
    else patch.industry = after.industry;
  }
  return patch;
}
