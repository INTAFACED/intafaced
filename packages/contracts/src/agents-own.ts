/**
 * AGENTS A PERSON BUILDS (AG-builder-01) — what svc-agents `own.*` answers. Browser-safe: zod only.
 *
 * A draft is the person's own and moves no value. Its tools come only from the service's addable catalogue; a tool
 * that moves money is listed with `movesMoney: true` so a builder can offer it and refuse it, and is never stored. A
 * blank per-session cap stays `null`, never zero or a default: the finding `agents.spend.cap_unset` blocks publishing.
 */

import { z } from 'zod';

export const OWN_AGENT_STATES = ['draft', 'published'] as const;

/** Something that stops a draft being published, as a code the surface words. */
export const ownAgentFindingSchema = z.object({ code: z.string(), blocksPublishing: z.boolean() });

export const ownAgentSchema = z.object({
  id: z.string().uuid(),
  template: z.string(),
  name: z.string(),
  instructions: z.string(),
  tools: z.array(z.string()),
  /** Canonical decimal string in the fee asset, or null while the person has not set it. */
  perSessionCap: z.string().nullable(),
  version: z.number().int().positive(),
  state: z.enum(OWN_AGENT_STATES),
  findings: z.array(ownAgentFindingSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OwnAgent = z.infer<typeof ownAgentSchema>;

export const ownAgentToolSchema = z.object({ name: z.string(), module: z.string(), movesMoney: z.boolean() });

/** `own.catalogue`: the templates a draft starts from and the tools it may be offered. */
export const ownAgentCatalogueSchema = z.object({
  templates: z.array(z.object({ id: z.string(), tools: z.array(z.string()) })),
  tools: z.array(ownAgentToolSchema),
});
export type OwnAgentCatalogue = z.infer<typeof ownAgentCatalogueSchema>;
