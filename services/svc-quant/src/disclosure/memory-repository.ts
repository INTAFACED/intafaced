import { QUANT_IDEMPOTENCY_CONFLICT, QuantError } from '../errors.js';
import type {
  DisclosureAcceptance,
  DisclosureAcceptInput,
  DisclosureCounts,
  DisclosurePublishInput,
  DisclosureRepository,
  DisclosureVersion,
} from './repository.js';

interface StoredVersion extends DisclosureVersion {
  readonly idempotencyKey: string;
}

function acceptanceKey(input: Omit<DisclosureAcceptInput, 'key'>): string {
  return [input.accountId, input.strategyId, input.strategyVersion, input.disclosureVersion].join('|');
}

/** In-memory store for router tests. Production passes Postgres. */
export function createMemoryDisclosureRepository(now: () => Date = () => new Date()): DisclosureRepository {
  const versions: StoredVersion[] = [];
  const accepted = new Map<string, DisclosureAcceptance>();

  return {
    async current() {
      const last = versions[versions.length - 1];
      return last ? { version: last.version, text: last.text, publishedAt: last.publishedAt } : null;
    },
    async publish(input: DisclosurePublishInput) {
      const prior = versions.find((row) => row.idempotencyKey === input.idempotencyKey);
      if (prior) {
        if (prior.text !== input.text) throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, 'idempotencyKey was used for different wording');
        return { version: prior.version, text: prior.text, publishedAt: prior.publishedAt };
      }
      const row: StoredVersion = {
        version: versions.length + 1,
        text: input.text,
        publishedAt: now().toISOString(),
        idempotencyKey: input.idempotencyKey,
      };
      versions.push(row);
      return { version: row.version, text: row.text, publishedAt: row.publishedAt };
    },
    async accept(input: DisclosureAcceptInput) {
      const id = acceptanceKey(input);
      const prior = accepted.get(id);
      if (prior) return prior;
      const row: DisclosureAcceptance = {
        accountId: input.accountId,
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        disclosureVersion: input.disclosureVersion,
        acceptedAt: now().toISOString(),
        key: input.key,
      };
      accepted.set(id, row);
      return row;
    },
    async acceptance(input) {
      return accepted.get(acceptanceKey(input)) ?? null;
    },
    async counts(): Promise<DisclosureCounts> {
      return {
        versions: versions.map((row) => ({
          version: row.version,
          publishedAt: row.publishedAt,
          acceptances: [...accepted.values()].filter((a) => a.disclosureVersion === row.version).length,
        })),
      };
    },
  };
}
