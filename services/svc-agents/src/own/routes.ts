import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  forwardedPrincipalHeaders,
  OWN_AGENT_DATA_CLASSES,
  OWN_AGENT_RULE_CHOICES,
  ownAgentApprovalRequestSchema,
  ownAgentConsentSchema,
  ownAgentEvalRunSchema,
  ownAgentEvalsSchema,
  ownAgentEvalStartSchema,
  ownAgentAnalyticsSchema,
  ownAgentDryRunStartSchema,
  ownAgentTestRunStartSchema,
  ownAgentToolTestStartSchema,
  type OwnAgentLiveEngine,
  ownAgentHoldsSchema,
  ownAgentTestRunSchema,
  ownAgentRuleSchema,
  ownAgentToolCallSchema,
  ownAgentCatalogueSchema,
  ownAgentLimitsSchema,
  ownAgentRunResultSchema,
  ownAgentRunRowSchema,
  ownAgentSchema,
  ownAgentSessionClosedSchema,
  ownAgentSessionSchema,
  ownAgentCoOwnerSchema,
  ownAgentDeleteSchema,
  ownAgentDeletedSchema,
  ownAgentPublicationSchema,
  ownAgentPublishSchema,
  ownAgentSharedSchema,
  ownAgentUsageDaySchema,
  ownAgentUsageWindowSchema,
  ownAgentAcceptSchema,
  ownAgentAssistantSchema,
  ownAgentDraftRequestSchema,
  ownAgentIdentitySchema,
  ownAgentIssuedTokenSchema,
  ownAgentProposalSchema,
  ownAgentTokenCallerSchema,
  ownAgentTokenCallSchema,
  ownAgentTokenSchema,
  publicProcedure,
  router,
  scopedProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { evaluateToolCall, parseGuardrail, type Guardrail } from '../fleet/guardrails.js';
import { executeProcedure } from '../procedures.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import { assertPersonSetsLimits } from '../spend/routes.js';
import {
  OWN_AGENTS_MAX,
  OWN_TEMPLATE_IDS,
  OWN_TEMPLATES,
  OWN_TOOL_DOORS,
  OWN_TOOLS,
  OwnAgentRefusal,
  type OwnTemplate,
} from './catalog.js';
import { OwnLimitsStore, readOwnCaps } from './limits.js';
import { OwnAgentStore, type OwnAgentView } from './store.js';
import { ownUsageLimitsRouter } from './usage-limits-routes.js';
import { checkCoOwner, checkSurfaces, OwnPublishingStore, type OwnAccountDirectory } from './publishing.js';
import { checkEvalRequest, OwnEvalStore } from './evaluations.js';
import { dryRunToolCall, ownAgentAnalytics, ownAgentHolds, OwnTestRunStore } from './dry-run.js';
import { checkRule, gateToolCall, OwnApprovalRequestStore, OwnConsentStore, OwnRuleStore, type PolicyBaseline } from './guardrails.js';
import { OwnIdentityStore, tokenLifetime } from './identity.js';
import { assistantEngine, draftAgent, OwnerDecisionPending } from './assistant.js';
import { invokeSupportDataTool } from '../support-agent/data-tools.js';
import type { SupportDeskPort } from '../support-agent/desk-port.js';
import type { SupportTierLaw } from '../support-agent/tier-gate.js';

/** The task every run of a person's own agent is routed and priced as. */
export const OWN_RUN_TASK = 'own.run';
/** A session of an own agent is `own.<agent id>`, a name no registered agent can take. */
export const ownSessionAgentId = (id: string): string => `own.${id}`;
/** As many actions as the product agents allow a session, and the run route's own output ceiling. */
const OWN_MAX_ACTIONS = 60;
const OWN_MAX_OUTPUT_TOKENS = 2048;

/**
 * The guardrail an own agent's session is bound to: its saved tools, read only, in their modules; the one run task;
 * and the agent's own cap per session as the ceiling. The person's caps for it are held at every run, as they stand.
 */
const writes = (tool: { dataClass: string | null }) => tool.dataClass === 'live_write' || tool.dataClass === 'draft_write';

export function ownGuardrail(agent: OwnAgentView): Guardrail {
  // A tool with no declared shape is never granted, even on a draft saved before shapes were declared.
  const tools = OWN_TOOLS.filter((tool) => !tool.movesMoney && tool.shape !== null && agent.tools.includes(tool.name));
  return parseGuardrail({
    agentId: ownSessionAgentId(agent.id),
    version: agent.version,
    capacityMode: 'research_only',
    scopes: [],
    // A write tool is granted as a write; whether a call of it asks first is the person's rules and the owner's baseline.
    tools: tools.map((tool) => ({
      name: tool.name,
      module: tool.module,
      mode: writes(tool) ? 'write' : 'read',
      // A write never runs at the runtime unapproved, whatever reaches it: the rules decide when to ask, and only an
      // approved request may pass this.
      requiresApproval: writes(tool),
    })),
    limits: {
      maxActionsPerSession: OWN_MAX_ACTIONS,
      maxOutputTokensPerCall: OWN_MAX_OUTPUT_TOKENS,
      maxSpendPerSession: agent.perSessionCap,
      allowedModules: [...new Set(tools.map((tool) => tool.module))],
      allowedTasks: [OWN_RUN_TASK],
    },
  });
}

/** A run's refusal or fault reaches the person as its code, which the Agents room words. */
function runError(err: unknown): never {
  if (err instanceof RefusedError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: err.refusal.code, cause: err });
  }
  if (err instanceof AgentError) {
    const code =
      err.code === 'agents.session_not_found'
        ? 'NOT_FOUND'
        : err.code === 'agents.provider_unavailable'
          ? 'SERVICE_UNAVAILABLE'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.code, cause: err });
  }
  if (err instanceof TRPCError) throw err;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'agents.error.engine_unavailable' });
}

/** What running needs; absent, every run route refuses as unavailable rather than half-working. */
export interface OwnRunDeps {
  readonly runtime: AgentRuntime;
  readonly feeAssetId: string;
  /** The engine this deployment runs the agent's live runs (`own.run`) on, read at each call from the wired adapter. */
  readonly liveEngine?: () => OwnAgentLiveEngine;
}

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

function sqlOf(sql: Sql | undefined): Sql {
  if (!sql) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return sql;
}

function runDepsOf(deps: OwnRunDeps | undefined): OwnRunDeps {
  if (!deps) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return deps;
}

/** The owner's values a limits view carries: the fee asset, and the overage grace (null when blank). */
function owner(run: OwnRunDeps | undefined): { overageGrace: string | null; assetId: string } {
  const { runtime, feeAssetId } = runDepsOf(run);
  const grace = runtime.overageGraceAmount;
  return { overageGrace: grace === null ? null : formatAmount(grace), assetId: feeAssetId };
}

const idInput = z.object({ id: z.string().min(1).max(64) });

/**
 * What the own agent's tool gates and doors need: the owner's baseline (blank refuses), and the doors of the tools
 * that are wired. Today that is the support desk's help search, read with the person's own forwarded principal.
 */
export interface OwnToolDeps {
  readonly baseline: PolicyBaseline;
  readonly supportDesk?: SupportDeskPort | null;
  readonly supportTierLaw?: SupportTierLaw | null;
  /** Identity's account read, which a co-owner must pass as one active person (AG-builder-03); absent refuses. */
  readonly accounts?: OwnAccountDirectory | null;
  /** The owner's lifetime of an agent's token, in minutes (AG-identity-01); blank refuses agents.identity.lifetime_unset. */
  readonly tokenLifetimeMinutes?: number | null;
  /** The owner's model for the drafting assistant (AG-builder-03); blank refuses owner.decision. */
  readonly assistantModel?: string | null;
}
const NO_TOOL_DEPS: OwnToolDeps = { baseline: {} };

/** A whole number as the person typed it, or undefined so the door refuses it as unset rather than guessing one. */
/** A tool's door answered with its own refusal reason; nothing was read. */
class DoorRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'DoorRefusal';
  }
}

function wholeNumber(text: string | undefined): number | undefined {
  const value = text?.trim() ?? '';
  return /^[0-9]{1,6}$/.test(value) ? Number(value) : undefined;
}

/** The person's own agent and a session of it. Not theirs, or not this agent's: one answer, so no oracle for others. */
async function ownedOwnSession(sql: Sql | undefined, runtime: AgentRuntime, userId: string, agentId: string, sessionId: string) {
  const agent = await guard(() => storeOf(sql).get(userId, agentId));
  const session = await runtime.session(sessionId);
  if (!session || session.userId !== userId || session.agentId !== ownSessionAgentId(agent.id)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'agents.session_not_found' });
  }
  return { agent, session };
}

/**
 * Agents a person builds for themselves (AG-builder-01). The owner is always the
 * signed-in person; a delegated token can neither build nor read their drafts,
 * whose instructions are theirs alone. Building moves no value.
 */
export function ownRouter(
  sql: Sql | undefined,
  run?: OwnRunDeps,
  templates: readonly OwnTemplate[] = OWN_TEMPLATE_IDS,
  tooling: OwnToolDeps = NO_TOOL_DEPS,
) {
  return router({
    /** The templates and the tools a draft may be given, with the ones that move money marked so they can be refused. */
    catalogue: scopedProcedure('agents:read', { module: 'agents' })
      .output(ownAgentCatalogueSchema)
      .query(() => {
        return {
          templates: templates.map((id) => ({ id, tools: [...OWN_TEMPLATES[id].tools] })),
          tools: OWN_TOOLS.map((tool) => ({
            ...tool,
            shape: tool.shape ? { input: { ...tool.shape.input }, output: { ...tool.shape.output } } : null,
            refusals: [...tool.refusals],
          })),
        };
      }),

    create: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ template: z.string().min(1).max(64), createKey: z.string().min(8).max(128) }))
      .output(ownAgentSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          // Only an offered template: one taken off the list is unknown to a create, as it is to the picker.
          const template = templates.find((id) => id === input.template);
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

    /** The agent's published versions, the version each surface carries, and each open session's version (AG-builder-03). */
    publication: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput)
      .output(ownAgentPublicationSchema)
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          return new OwnPublishingStore(sqlOf(sql)).publication(ctx.principal.userId, agent.id, ownSessionAgentId(agent.id));
        });
      }),

    /**
     * Publishes the agent's current version to the chosen surfaces (AG-builder-03; J-agents-03 #7). A finding that blocks
     * publishing refuses with its code; a surface the policy forbids refuses `agents.own.surface_not_reviewed`. Either
     * way nothing is published and no surface moves. Only the chosen surfaces move; the rest keep their version.
     */
    publish: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(ownAgentPublishSchema)
      .output(ownAgentPublicationSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const surfaces = checkSurfaces(input.surfaces);
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          const publishing = new OwnPublishingStore(sqlOf(sql));
          await publishing.publish(ctx.principal.userId, agent.id, surfaces);
          return publishing.publication(ctx.principal.userId, agent.id, ownSessionAgentId(agent.id));
        });
      }),

    /**
     * The agent's co-owners (AG-builder-03; J-agents-03 #8): each one person, by account id, whom identity reads as an
     * active account. A group, team or business is refused `agents.own.co_owner_group`; so is the owner themself.
     */
    coOwners: router({
      list: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(z.array(ownAgentCoOwnerSchema))
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            return new OwnPublishingStore(sqlOf(sql)).coOwners(ctx.principal.userId, agent.id);
          });
        }),
      add: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput.extend({ coOwner: z.string().max(200) }))
        .output(z.array(ownAgentCoOwnerSchema))
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            const coOwnerId = checkCoOwner(ctx.principal.userId, input.coOwner);
            const publishing = new OwnPublishingStore(sqlOf(sql));
            if (await publishing.isGroup(coOwnerId)) throw new OwnAgentRefusal('agents.own.co_owner_group');
            // One active person, as identity reads them; an account it cannot read is refused, never added on a guess.
            const read = tooling.accounts ? await tooling.accounts.readAccount(coOwnerId) : { status: 'unread' as const };
            if (read.status !== 'ok') throw new OwnAgentRefusal('agents.own.co_owner_unread');
            if (read.account.status !== 'active') throw new OwnAgentRefusal('agents.own.co_owner_inactive');
            await publishing.addCoOwner(ctx.principal.userId, agent.id, coOwnerId);
            return publishing.coOwners(ctx.principal.userId, agent.id);
          });
        }),
      remove: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput.extend({ coOwner: z.string().max(200) }))
        .output(z.array(ownAgentCoOwnerSchema))
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            const publishing = new OwnPublishingStore(sqlOf(sql));
            await publishing.removeCoOwner(ctx.principal.userId, agent.id, input.coOwner.trim().toLowerCase());
            return publishing.coOwners(ctx.principal.userId, agent.id);
          });
        }),
    }),

    /** Other people's agents this person co-owns, newest first, read only. */
    sharedWithMe: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentSharedSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(() => new OwnPublishingStore(sqlOf(sql)).sharedWith(ctx.principal.userId, input.limit));
      }),

    /**
     * Deletes a draft for good (J-agents-03 #8), only with the person's confirmation, sent as `delete for good`; without it the
     * service refuses `agents.own.delete_unconfirmed` and keeps it. A published agent, or one that has opened a
     * session, is refused and kept whole.
     */
    delete: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(ownAgentDeleteSchema)
      .output(ownAgentDeletedSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          await new OwnPublishingStore(sqlOf(sql)).deleteDraft(ctx.principal.userId, agent.id, ownSessionAgentId(agent.id), input.confirm);
          return { id: agent.id, deleted: true as const };
        });
      }),

    /**
     * The person's standing rules for this agent (AG-guardrails-02): one per tool, which only narrow. A rule that lets a
     * live-write tool act without asking is refused `agents.rule_invalid`; one looser than the owner's baseline is
     * refused `agents.baseline_loosen_refused`, and nothing is stored for either.
     */
    rules: router({
      list: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(z.array(ownAgentRuleSchema))
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            return new OwnRuleStore(sqlOf(sql)).list(ctx.principal.userId, agent.id);
          });
        }),
      save: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput.extend({ tool: z.string().min(1).max(120), choice: z.enum(OWN_AGENT_RULE_CHOICES) }))
        .output(ownAgentRuleSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            checkRule(tooling.baseline, agent.tools, input.tool, input.choice);
            return new OwnRuleStore(sqlOf(sql)).save(ctx.principal.userId, agent.id, input.tool, input.choice);
          });
        }),
    }),

    /**
     * The person's consent to each class of tools this agent uses (AG-guardrails-01). Until a class is granted every
     * call of it is refused `agents.consent_required`; revoking withdraws it for the next call.
     */
    consents: router({
      list: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(z.array(ownAgentConsentSchema))
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            return new OwnConsentStore(sqlOf(sql)).list(ctx.principal.userId, agent.id);
          });
        }),
      grant: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput.extend({ dataClass: z.enum(OWN_AGENT_DATA_CLASSES) }))
        .output(ownAgentConsentSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            return new OwnConsentStore(sqlOf(sql)).grant(ctx.principal.userId, agent.id, input.dataClass);
          });
        }),
      revoke: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput.extend({ dataClass: z.enum(OWN_AGENT_DATA_CLASSES) }))
        .output(ownAgentConsentSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            return new OwnConsentStore(sqlOf(sql)).revoke(ctx.principal.userId, agent.id, input.dataClass);
          });
        }),
    }),

    /**
     * The agent's own identity (AG-identity-01; J-agents-03 #5): its token's owner, scopes and expiry. Issuing needs the
     * owner's token lifetime (blank refuses agents.identity.lifetime_unset, and nothing is issued); the token is shown
     * once. Revoking makes the next call made with it fail.
     */
    identity: router({
      get: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(ownAgentIdentitySchema)
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            return { token: await new OwnIdentityStore(sqlOf(sql)).latest(ctx.principal.userId, agent.id) };
          });
        }),
      issue: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(ownAgentIssuedTokenSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            const lifetime = tokenLifetime(tooling.tokenLifetimeMinutes);
            return new OwnIdentityStore(sqlOf(sql)).issue(ctx.principal.userId, agent.id, agent.tools, lifetime);
          });
        }),
      revoke: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(ownAgentTokenSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            return new OwnIdentityStore(sqlOf(sql)).revoke(ctx.principal.userId, agent.id);
          });
        }),
      /**
       * A call the agent makes with its own token, not the person's session: who it acts as. Refused by name when the
       * token is unknown, revoked or expired, and while its owner's account is frozen, closed or cannot be read.
       */
      agentCall: publicProcedure
        .input(ownAgentTokenCallSchema)
        .output(ownAgentTokenCallerSchema)
        .mutation(async ({ input }) => {
          try {
            return await new OwnIdentityStore(sqlOf(sql)).call(input.token, tooling.accounts ?? null);
          } catch (err) {
            if (!(err instanceof OwnAgentRefusal)) throw err;
            const owner = err.code.startsWith('agents.identity.owner_');
            throw new TRPCError({ code: owner ? 'FORBIDDEN' : 'UNAUTHORIZED', message: err.code, cause: err });
          }
        }),
    }),

    /**
     * Drafting with the assistant (AG-builder-03; J-agents-03 #6). While the owner has not chosen the model a draft
     * refuses owner.decision; the rest of the builder works without it. A draft's tools passed the validator, and
     * nothing is saved until the person accepts it.
     */
    assistant: router({
      state: scopedProcedure('agents:read', { module: 'agents' })
        .output(ownAgentAssistantSchema)
        .query(() => ({ engine: assistantEngine(tooling.assistantModel) })),
      draft: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(ownAgentDraftRequestSchema)
        .output(ownAgentProposalSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          try {
            return draftAgent(assistantEngine(tooling.assistantModel), input.description);
          } catch (err) {
            if (err instanceof OwnerDecisionPending) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.code });
            if (err instanceof OwnAgentRefusal) throw new TRPCError({ code: 'BAD_REQUEST', message: err.code, cause: err });
            throw err;
          }
        }),
      accept: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(ownAgentAcceptSchema)
        .output(ownAgentSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          const { acceptKey, ...draft } = input;
          return guard(() => storeOf(sql).createDrafted(ctx.principal.userId, { ...draft, perSessionCap: null }, `assistant:${acceptKey}`));
        }),
    }),

    /** The calls of this agent's tools that a rule held for the person, newest first. None of them has run. */
    approvals: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput.extend({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentApprovalRequestSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          return new OwnApprovalRequestStore(sqlOf(sql)).list(ctx.principal.userId, agent.id, input.limit);
        });
      }),

    /**
     * The agent's test set and evaluations (AG-testing-02). A start runs every case `repeats` times on the test engine:
     * no model is called, nothing is billed and nothing reaches the ledger; every result is labelled TEST. A blank
     * threshold refuses `agents.eval.threshold_unset` and a blank repeats count `agents.eval.repeats_unset`, and nothing
     * is run or stored. The same request id again is the same run.
     */
    evals: router({
      get: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput.extend({ limit: z.number().int().min(1).max(50) }))
        .output(ownAgentEvalsSchema)
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            const evals = new OwnEvalStore(sqlOf(sql));
            const [testSet, latest, runs] = await Promise.all([
              evals.testSet(ctx.principal.userId, agent.id),
              evals.latest(ctx.principal.userId, agent.id),
              evals.runs(ctx.principal.userId, agent.id, input.limit),
            ]);
            return { testSet, latest, runs };
          });
        }),
      start: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(ownAgentEvalStartSchema)
        .output(ownAgentEvalRunSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => {
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            const request = checkEvalRequest(input);
            return new OwnEvalStore(sqlOf(sql)).start(ctx.principal.userId, agent.id, input.requestId, request);
          });
        }),
    }),

    /**
     * A dry run of one call of one of the agent's tools (AG-spend-04): every check a real call meets, in its order, and
     * what the call would do. It opens no session and calls no tool, runtime, spend gate or ledger, so no ledger entry,
     * intent or reservation is made; it is stored as a test run, labelled TEST and never billed. The same request id
     * again is the same dry run.
     */
    dryRun: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(ownAgentDryRunStartSchema)
      .output(ownAgentTestRunSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const { feeAssetId } = runDepsOf(run);
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          const call = { tool: input.tool, input: input.input };
          return new OwnTestRunStore(sqlOf(sql), feeAssetId).dryRun(ctx.principal.userId, agent.id, input.requestId, call, () =>
            dryRunToolCall(sqlOf(sql), tooling.baseline, { ownerId: ctx.principal.userId, agent, ...call }),
          );
        });
      }),

    /**
     * One question asked of the agent on the test engine (AG-testing-01; J-agents-04 #1): mode test, cost 0, the reply and
     * every log row labelled TEST. The test engine answers whatever engine this deployment runs live runs on, which the
     * run keeps beside it: no provider is called, no session is opened, and no reservation, usage row or ledger call is
     * made. The same request id again is that run.
     */
    testRun: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(ownAgentTestRunStartSchema)
      .output(ownAgentTestRunSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const { feeAssetId, liveEngine } = runDepsOf(run);
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          const engine = liveEngine ? liveEngine() : 'unknown';
          return new OwnTestRunStore(sqlOf(sql), feeAssetId).engineRun(ctx.principal.userId, agent.id, input.requestId, input.ask, engine);
        });
      }),

    /**
     * A tool that moves value, tested (AG-testing-01; J-agents-04 #2): what a call of it would do, and that a real call by
     * the person's own agent is refused `agents.own.money_tool`. Nothing is sent: no ledger call, no session, no
     * reservation and no intent. The same request id again is that test.
     */
    toolTest: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(ownAgentToolTestStartSchema)
      .output(ownAgentTestRunSchema)
      .mutation(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const { feeAssetId } = runDepsOf(run);
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          return new OwnTestRunStore(sqlOf(sql), feeAssetId).toolTest(ctx.principal.userId, agent.id, input.requestId, input.tool);
        });
      }),

    /** The agent's test runs, newest first, apart from its live runs (`own.runs`). Each is labelled TEST and cost 0. */
    testRuns: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput.extend({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentTestRunSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const { feeAssetId } = runDepsOf(run);
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          return new OwnTestRunStore(sqlOf(sql), feeAssetId).list(ctx.principal.userId, agent.id, input.limit);
        });
      }),

    /** What the agent holds for the person across its sessions: sessions, spend reservations and place intents. */
    holds: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput)
      .output(ownAgentHoldsSchema)
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          return ownAgentHolds(sqlOf(sql), ctx.principal.userId, ownSessionAgentId(agent.id));
        });
      }),

    /** The agent's runs by outcome and their cost: live runs only, unless the person includes test runs. */
    analytics: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput.extend({ includeTest: z.boolean().optional() }))
      .output(ownAgentAnalyticsSchema)
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const { feeAssetId } = runDepsOf(run);
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          return ownAgentAnalytics(sqlOf(sql), {
            ownerId: ctx.principal.userId,
            agentId: agent.id,
            sessionAgentId: ownSessionAgentId(agent.id),
            includeTest: input.includeTest === true,
            assetId: feeAssetId,
          });
        });
      }),

    tool: router({
      /**
       * One call of one of the agent's tools in its open session: consent for the tool's class, then the owner's
       * baseline, then the person's rule, then the session's own guardrail. A call a rule asks about is stored as an
       * approval request, once per request id, and the tool does not run. A tool with no door refuses
       * `agents.tool_not_wired` and runs nothing.
       */
      try: executeProcedure()
        .input(
          idInput.extend({
            sessionId: z.string().uuid(),
            requestId: z.string().min(8).max(200),
            tool: z.string().min(1).max(120),
            input: z.record(z.string().max(64), z.string().max(4000)).refine((args) => Object.keys(args).length <= 8),
          }),
        )
        .output(ownAgentToolCallSchema)
        .mutation(async ({ ctx, input }) => {
          const { runtime } = runDepsOf(run);
          const { agent, session } = await ownedOwnSession(sql, runtime, ctx.principal.userId, input.id, input.sessionId);
          const requests = new OwnApprovalRequestStore(sqlOf(sql));
          // A request id already held for the person is that request, whatever the rules say now: never a second call.
          const held = await guard(() => requests.find(ctx.principal.userId, session.id, input.requestId, input.tool, input.input));
          if (held) return { outcome: 'waiting' as const, tool: input.tool, dataClass: held.dataClass, request: held.request };
          const gate = await guard(() =>
            gateToolCall(sqlOf(sql), tooling.baseline, {
              ownerId: ctx.principal.userId,
              agentId: agent.id,
              agentTools: agent.tools,
              tool: input.tool,
            }),
          );
          if (gate.kind === 'ask') {
            // The session's own guardrail first, as for a call that runs: open, inside its action limit, and the tool
            // declared when the session opened. Only the approval itself is left out: that is what this request asks.
            const decision = evaluateToolCall(session.guardrail, await runtime.stateOf(session), { tool: input.tool, approved: true });
            if (!decision.allowed) throw new TRPCError({ code: 'FORBIDDEN', message: decision.code });
            const request = await guard(() =>
              requests.hold({
                ownerId: ctx.principal.userId,
                agentId: agent.id,
                sessionId: session.id,
                requestId: input.requestId,
                tool: input.tool,
                args: input.input,
                ruleId: gate.ruleId,
              }),
            );
            return { outcome: 'waiting' as const, tool: input.tool, dataClass: gate.dataClass, request };
          }
          // A tool with no door runs nothing; the catalogue names this refusal for every such tool.
          if (!OWN_TOOL_DOORS.has(input.tool)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'agents.tool_not_wired' });
          const desk = tooling.supportDesk ?? null;
          try {
            // A retried read runs the read again and is recorded again: it moves nothing and holds nothing.
            const acted = await runtime.act({
              sessionId: session.id,
              tool: input.tool,
              execute: async () => {
                const result = await invokeSupportDataTool({
                  tool: input.tool,
                  plane: desk ? 'live' : 'dark',
                  requesterUserId: ctx.principal.userId,
                  tierLaw: tooling.supportTierLaw ?? null,
                  userTier: ctx.principal.tier,
                  desk,
                  deskHeaders: forwardedPrincipalHeaders(ctx),
                  kbQuery: input.input.kbQuery ?? null,
                  ...(wholeNumber(input.input.limit) === undefined ? {} : { kbSearchLimit: wholeNumber(input.input.limit) }),
                });
                // The door's own refusal is a refusal, recorded as a failed call, never an answer that ran.
                if (result.status === 'refuse') throw new DoorRefusal(result.reason);
                return result;
              },
            });
            return { outcome: 'ran' as const, tool: input.tool, dataClass: gate.dataClass, result: acted.result };
          } catch (err) {
            if (err instanceof DoorRefusal) throw new TRPCError({ code: 'BAD_REQUEST', message: `agents.tool_refused.${err.reason}` });
            return runError(err);
          }
        }),
    }),

    /** The soft alert and monthly hard limit the person set for this agent (J-agents-02). */
    usageLimits: ownUsageLimitsRouter(sql, run),

    /** The caps the person set for this agent, its own cap, and the per-session cap that applies (AG-spend-01). */
    limits: router({
      get: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(idInput)
        .output(ownAgentLimitsSchema)
        .query(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(async () => ({ ...(await new OwnLimitsStore(sqlOf(sql)).get(ctx.principal.userId, input.id)), ...owner(run) }));
        }),

      /** All three caps or none. Blank refuses `agents.spend.cap_unset`; above the agent's own cap is refused, not lowered. */
      set: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(
          idInput.extend({
            perCall: z.string().max(64).nullable(),
            perSession: z.string().max(64).nullable(),
            perPeriod: z.string().max(64).nullable(),
          }),
        )
        .output(ownAgentLimitsSchema)
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          const { id, ...caps } = input;
          return guard(async () => ({ ...(await new OwnLimitsStore(sqlOf(sql)).set(ctx.principal.userId, id, caps)), ...owner(run) }));
        }),
    }),

    session: router({
      /**
       * Opens a session of the person's own agent. Refused `agents.spend.cap_unset`, with no session made, until the
       * agent has its own cap and the person has set theirs for it: nothing of an own agent runs uncapped.
       */
      open: executeProcedure()
        .input(idInput)
        .output(ownAgentSessionSchema)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const { runtime } = runDepsOf(run);
            const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
            if (!(await readOwnCaps(sqlOf(sql), ctx.principal.userId, agent.id))) throw new OwnAgentRefusal('agents.spend.cap_unset');
            const session = await runtime.openOwnSession({ userId: ctx.principal.userId, guardrail: ownGuardrail(agent) });
            // The session keeps this version's instructions for its whole life (AG-builder-03); its tools and cap are in
            // its guardrail already.
            await new OwnPublishingStore(sqlOf(sql)).pinSession(
              ctx.principal.userId,
              agent.id,
              session.id,
              session.guardrailVersion,
              agent.instructions,
            );
            return { sessionId: session.id, agentId: session.agentId, version: session.guardrailVersion };
          }),
        ),

      /**
       * Closes a session of the person's own agent once its windows are paid, each on its own charge key. A window the
       * ledger refuses for funds stays unpaid and the session stays open: refused `agents.window_unpaid`.
       */
      close: executeProcedure()
        .input(idInput.extend({ sessionId: z.string().uuid() }))
        .output(ownAgentSessionClosedSchema)
        .mutation(async ({ ctx, input }) => {
          const { runtime } = runDepsOf(run);
          const { session } = await ownedOwnSession(sql, runtime, ctx.principal.userId, input.id, input.sessionId);
          try {
            const closed = await runtime.closeSettled(session.id);
            return { sessionId: closed.id, status: 'closed' as const, closedAt: (closed.closedAt ?? new Date()).toISOString() };
          } catch (err) {
            return runError(err);
          }
        }),
    }),

    /**
     * One run: the agent's instructions and the person's question, held against the agent's caps and the person's
     * balance before the engine is called. The same request id twice is one run and one charge.
     */
    run: executeProcedure()
      .input(
        idInput.extend({
          sessionId: z.string().uuid(),
          requestId: z.string().min(8).max(200),
          ask: z.string().min(1).max(4000),
        }),
      )
      .output(ownAgentRunResultSchema)
      .mutation(async ({ ctx, input }) => {
        const deps = runDepsOf(run);
        const { agent, session } = await ownedOwnSession(sql, deps.runtime, ctx.principal.userId, input.id, input.sessionId);
        // A session keeps the instructions it opened on (AG-builder-03), whatever was edited or published since. One
        // opened before sessions were pinned reads the agent as it stands.
        const pinned = await new OwnPublishingStore(sqlOf(sql)).sessionInstructions(ctx.principal.userId, session.id);
        const instructions = pinned ?? agent.instructions;
        try {
          const result = await deps.runtime.think({
            sessionId: session.id,
            requestId: input.requestId,
            task: OWN_RUN_TASK,
            ...(instructions.trim() ? { system: instructions } : {}),
            messages: [{ role: 'user', content: input.ask }],
          });
          return {
            text: result.text,
            cost: formatAmount(result.cost),
            assetId: deps.feeAssetId,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          };
        } catch (err) {
          return runError(err);
        }
      }),

    /** Every run asked of this agent by the person, newest first: admitted, refused with its code, or failed. */
    runs: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput.extend({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentRunRowSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const { feeAssetId } = runDepsOf(run);
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          const rows = await sqlOf(sql)<
            Array<{
              session_id: string;
              sequence: number;
              status: 'executed' | 'refused' | 'failed';
              task: string | null;
              refusal_code: string | null;
              cost: string;
              occurred_at: Date;
            }>
          >`
            SELECT a.session_id::text, a.sequence, a.status, a.task, a.refusal_code, a.cost::text, a.occurred_at
              FROM agents.agent_actions a
             WHERE a.user_id = ${ctx.principal.userId}
               AND a.agent_id = ${ownSessionAgentId(agent.id)}
               AND a.kind = 'completion'
             ORDER BY a.occurred_at DESC, a.sequence DESC
             LIMIT ${input.limit}
          `;
          return rows.map((row) => ({
            sessionId: row.session_id,
            sequence: row.sequence,
            status: row.status,
            task: row.task,
            refusalCode: row.refusal_code,
            cost: formatAmount(parseAmount(row.cost)),
            assetId: feeAssetId,
            occurredAt: row.occurred_at.toISOString(),
          }));
        });
      }),

    /** The usage windows of this agent's sessions, newest first: open, unpaid (retried on its charge key) or settled. */
    usage: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(idInput.extend({ limit: z.number().int().min(1).max(200) }))
      .output(z.array(ownAgentUsageWindowSchema))
      .query(({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const agent = await storeOf(sql).get(ctx.principal.userId, input.id);
          const windows = await runDepsOf(run).runtime.usageWindowsOf(ctx.principal.userId, ownSessionAgentId(agent.id), input.limit);
          return windows.map((w) => ({
            ...w,
            amount: w.amount === null ? null : formatAmount(w.amount),
            openedAt: w.openedAt.toISOString(),
          }));
        });
      }),

    /**
     * The sealed usage of every agent the person built, by agent, UTC day and task. Each row is the exact sum of the
     * sealed windows it covers, so an agent's rows add up to the amounts its Usage windows show.
     */
    usageByDay: scopedProcedure('agents:read', { module: 'agents', person: true })
      .output(z.array(ownAgentUsageDaySchema))
      .query(({ ctx }) => {
        assertPersonSetsLimits(ctx.principal);
        return guard(async () => {
          const agents = await storeOf(sql).list(ctx.principal.userId, OWN_AGENTS_MAX);
          const names = new Map(agents.map((agent) => [ownSessionAgentId(agent.id), agent]));
          const rows = await runDepsOf(run).runtime.usageByDayOf(ctx.principal.userId, [...names.keys()]);
          return rows.map((row) => {
            const agent = names.get(row.agentId)!;
            return { ...row, agentId: agent.id, agentName: agent.name, amount: formatAmount(row.amount) };
          });
        });
      }),
  });
}
