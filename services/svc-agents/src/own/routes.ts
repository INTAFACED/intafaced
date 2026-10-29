import type { Sql } from 'postgres';
import { z } from 'zod';
import { ownAgentCatalogueSchema, ownAgentSchema, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { assertPersonSetsLimits } from '../spend/routes.js';
import { OWN_TEMPLATE_IDS, OWN_TEMPLATES, OWN_TOOLS, OwnAgentRefusal } from './catalog.js';
import { OwnAgentStore } from './store.js';

/** A refusal reaches the person as its code, which the Agents room words; anything else is a fault. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof OwnAgentRefusal)) throw err;
    throw new TRPCError({ code: err.code === 'agents.own.not_found' ? 'NOT_FOUND' : 'BAD_REQUEST', message: err.code, cause: err });
  }
}

function storeOf(sql: Sql | undefined): OwnAgentStore {
  if (!sql) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return new OwnAgentStore(sql);
}

/**
 * Agents a person builds for themselves (AG-builder-01). The owner is always the
 * signed-in person; a delegated token can neither build nor read their drafts,
 * whose instructions are theirs alone. Building moves no value.
 */
export function ownRouter(sql: Sql | undefined) {
  return router({
    /** The templates and the tools a draft may be given, with the ones that move money marked so they can be refused. */
    catalogue: scopedProcedure('agents:read', { module: 'agents' })
      .output(ownAgentCatalogueSchema)
      .query(() => {
        return {
          templates: OWN_TEMPLATE_IDS.map((id) => ({ id, tools: [...OWN_TEMPLATES[id].tools] })),
          tools: OWN_TOOLS.map((tool) => ({ ...tool })),
        };
      }),

    create: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ template: z.string().min(1).max(64), createKey: z.string().min(8).max(128) }))
      .output(ownAgentSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const template = OWN_TEMPLATE_IDS.find((id) => id === input.template);
          if (!template) throw new OwnAgentRefusal('agents.own.template_unknown');
          return storeOf(sql).create(ctx.principal.userId, template, input.createKey);
        });
      }),

    save: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(
        z.object({
          id: z.string().min(1).max(64),
          name: z.string().max(200),
          instructions: z.string().max(20_000),
          tools: z.array(z.string().max(120)).max(50),
          perSessionCap: z.string().max(64).nullable(),
        }),
      )
      .output(ownAgentSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        const { id, ...draft } = input;
        return guard(() => storeOf(sql).save(ctx.principal.userId, id, draft));
      }),

    get: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ id: z.string().min(1).max(64) }))
      .output(ownAgentSchema)
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(() => storeOf(sql).get(ctx.principal.userId, input.id));
      }),

    list: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(() => storeOf(sql).list(ctx.principal.userId, input.limit));
      }),
  });
}
