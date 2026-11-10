import { keccak256, toHex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/**
 * The venue agent key INTAFACED holds for one agent account (J-agents-21: "our copy of the venue agent key").
 *
 * Derived, never stored: keccak256 of the owner's seed (`TRADE_AGENT_KEY_SEED`, a secret the owner sets; blank refuses
 * `agents.agent_key_unset`), the person's user id and the agent account's id. So no private key sits in a table, the
 * same account always derives the same key (a retried approval names the same address), and a new agent account is a
 * new key: an address once approved is never approved again (user-venue.ts `ApproveAgentIntent`; the table's unique
 * index on `agent_address`). Only the address leaves this file; the signer that uses the key goes through
 * `CappedAgentSigner` (venue-contracts agent-cap.ts) and nowhere else.
 *
 * The seed on test stacks is a public TEST phrase (tooling/profiles/test-owner-values/trade.json): every key derived from
 * it holds nothing anywhere but the TEST venue's memory.
 */
export function agentKeyFor(seed: string, userId: string, accountId: string): PrivateKeyAccount {
  if (seed.trim() === '') throw new Error('agent key seed is blank');
  return privateKeyToAccount(keccak256(toHex(`intafaced agent key\u0000${seed}\u0000${userId}\u0000${accountId}`)));
}

export function agentAddressFor(seed: string, userId: string, accountId: string): string {
  return agentKeyFor(seed, userId, accountId).address.toLowerCase();
}
