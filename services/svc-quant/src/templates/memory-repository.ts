import { QUANT_IDEMPOTENCY_CONFLICT, QuantError } from '../errors.js';
import { sameContent, type TemplatePublishInput, type TemplateRepository, type TemplateVersion } from './repository.js';

/** In-memory templates for router tests. Production passes Postgres. */
export function createMemoryTemplateRepository(now: () => Date = () => new Date()): TemplateRepository {
  const rows: (TemplateVersion & { idempotencyKey: string })[] = [];
  const strip = ({ idempotencyKey: _key, ...row }: TemplateVersion & { idempotencyKey: string }): TemplateVersion => row;

  return {
    async publish(input: TemplatePublishInput) {
      const prior = rows.find((row) => row.idempotencyKey === input.idempotencyKey);
      if (prior) {
        if (!sameContent(prior, input))
          throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, 'idempotencyKey was used for a different template');
        return strip(prior);
      }
      const version = rows.filter((row) => row.id === input.id).length + 1;
      const row = {
        id: input.id,
        version,
        name: input.name,
        description: input.description,
        rules: structuredClone(input.rules),
        releaseNote: input.releaseNote,
        publishedAt: now().toISOString(),
        idempotencyKey: input.idempotencyKey,
      };
      rows.push(row);
      return strip(row);
    },
    async list({ limit, cursor }) {
      const newest = new Map<string, TemplateVersion>();
      for (const row of rows) {
        const held = newest.get(row.id);
        if (!held || held.version < row.version) newest.set(row.id, strip(row));
      }
      const ordered = [...newest.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((row) => !cursor || row.id > cursor);
      const page = ordered.slice(0, limit);
      return { templates: page, nextCursor: ordered.length > limit ? (page[page.length - 1]?.id ?? null) : null };
    },
    async get(id) {
      const found = rows.filter((row) => row.id === id).map(strip);
      return found.length ? found.sort((a, b) => b.version - a.version) : null;
    },
  };
}
