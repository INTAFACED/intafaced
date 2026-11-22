/**
 * The codes the Identity page (AG-identity-01) and the drafting assistant (AG-builder-03) word, each with its words'
 * key in `agentBuilderCopy`; any other failure is the app's own account of it. Shared by `AgentIdentity.tsx` and the
 * New agent room, so both say the same words.
 */
const CODE_WORDS = {
  'owner.decision': 'code_owner_decision',
  'agents.assistant.engine_unavailable': 'code_assistant_engine_unavailable',
  'agents.assistant.description_blank': 'code_assistant_description_blank',
  'agents.identity.lifetime_unset': 'code_identity_lifetime_unset',
  'agents.identity.no_live_token': 'code_identity_no_live_token',
  'agents.identity.owner_frozen': 'code_identity_owner_frozen',
  'agents.identity.owner_inactive': 'code_identity_owner_inactive',
  'agents.identity.owner_unread': 'code_identity_owner_unread',
  'agents.tool_shape_missing': 'code_tool_shape_missing',
  'agents.own.money_tool': 'code_own_money_tool',
  'agents.own.tool_unknown': 'code_own_tool_unknown',
  'agents.own.too_many': 'code_own_too_many',
  'agents.own.not_found': 'code_own_not_found',
} as const;

/** The words' key for a failure's message, or null when it is not one of these codes. */
export const identityWordsKey = (message: string) =>
  Object.hasOwn(CODE_WORDS, message) ? CODE_WORDS[message as keyof typeof CODE_WORDS] : null;
