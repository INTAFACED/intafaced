import type { Sql } from 'postgres';
import { OPS_PROTOCOL_LISTING_STORAGE_UNCONFIGURED, OpsError } from '../codes.js';

/**
 * The reasons a hide or delist may name, and where the list comes from (D-order-controls-04).
 *
 * A reason code is a design list, not a money setting, so it has a default and the admin can change it. The list in force is
 * the newest admin edit, else the deployment's `OPS_PROTOCOL_REASON_CODES`, else the default below. Every edit is logged with
 * who made it. A hide checks the list in force when it is made.
 *
 * The default names the reasons exchanges and token lists most often give for removing a listing: fraud, an exploit or
 * security incident, legal or regulatory demand, sanctions exposure, a copy of another asset, a broken contract, an abandoned
 * market, and the owner's own request. It is a starting point to edit, not a legal position.
 */
export const DEFAULT_REASON_CODES: readonly string[] = [
  'scam_or_fraud',
  'security_incident',
  'contract_defect',
  'legal_or_regulatory',
  'sanctions_exposure',
  'impersonation',
  'abandoned_or_illiquid',
  'owner_request',
];

export type ReasonCodeSource = 'default' | 'env' | 'admin';

export interface ReasonCodesInForce {
  readonly source: ReasonCodeSource;
  readonly codes: readonly string[];
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface ReasonCodeStore {
  /** The newest admin edit, or null when none was ever made. */
  latest(): Promise<{ codes: readonly string[]; changedBy: string; changedAt: string } | null>;
  append(codes: readonly string[], changedBy: string, at: string): Promise<void>;
}

/** For tests that need a store without PostgreSQL. */
export function createMemoryReasonCodeStore(): ReasonCodeStore {
  const changes: { codes: readonly string[]; changedBy: string; changedAt: string }[] = [];
  return {
    async latest() {
      return changes.at(-1) ?? null;
    },
    async append(codes, changedBy, at) {
      changes.push({ codes: [...codes], changedBy, changedAt: at });
    },
  };
}

export function createPgReasonCodeStore(sql: Sql): ReasonCodeStore {
  return {
    async latest() {
      const [row] = await sql<
        { codes: string[]; changed_by: string; changed_at: Date }[]
      >`SELECT codes,changed_by,changed_at FROM ops.protocol_reason_code_changes ORDER BY id DESC LIMIT 1`;
      return row ? { codes: row.codes, changedBy: row.changed_by, changedAt: row.changed_at.toISOString() } : null;
    },
    async append(codes, changedBy, at) {
      await sql`INSERT INTO ops.protocol_reason_code_changes (codes,changed_by,changed_at) VALUES (${[...codes]},${changedBy},${at})`;
    },
  };
}

export interface ReasonCodes {
  inForce(): Promise<ReasonCodesInForce>;
  /** Replaces the whole list. Refuses without storage, so an edit is never accepted and then lost. */
  set(codes: readonly string[], changedBy: string): Promise<ReasonCodesInForce>;
}

export function createReasonCodes(deps: {
  store: ReasonCodeStore | undefined;
  /** `OPS_PROTOCOL_REASON_CODES`, already split. Null or empty means not set. */
  envCodes: readonly string[] | null;
  now: () => string;
}): ReasonCodes {
  const inForce = async (): Promise<ReasonCodesInForce> => {
    const edit = deps.store ? await deps.store.latest() : null;
    if (edit) return { source: 'admin', codes: edit.codes, updatedAt: edit.changedAt, updatedBy: edit.changedBy };
    if (deps.envCodes && deps.envCodes.length > 0) return { source: 'env', codes: deps.envCodes, updatedAt: null, updatedBy: null };
    return { source: 'default', codes: DEFAULT_REASON_CODES, updatedAt: null, updatedBy: null };
  };
  return {
    inForce,
    async set(codes, changedBy) {
      if (!deps.store) {
        throw new OpsError(
          OPS_PROTOCOL_LISTING_STORAGE_UNCONFIGURED,
          'No durable storage is configured for the reason code list, so an edit would be lost. Nothing was changed.',
        );
      }
      await deps.store.append(codes, changedBy, deps.now());
      return inForce();
    },
  };
}
