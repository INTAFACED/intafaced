/**
 * Who signs an order a room prepares on the person's own venue account: the owner's wallet (the default), or the
 * person's trading session key on a venue whose trades only a session key signs (status `tradesSignedBy: session_key`:
 * Hyperliquid's orders name chain 1337, which a wallet refuses). The door checks an agent is this sign-in's live
 * session key and refuses one on an owner-only intent.
 *
 * The agent key a request names, lowercased; null when the owner's wallet signs (no signer, or the owner named).
 * Anything else is refused through `bad`, before anything is read.
 */
export function agentSignerOf(raw: unknown, bad: (message: string) => never): { role: 'agent'; address: string } | null {
  if (raw === undefined || raw === null) return null;
  const role: unknown = typeof raw === 'object' && 'role' in raw ? raw.role : undefined;
  const address: unknown = typeof raw === 'object' && 'address' in raw ? raw.address : undefined;
  if ((role !== 'owner' && role !== 'agent') || typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address))
    bad("signer must be the owner's wallet or an agent key, with its address");
  return role === 'agent' ? { role, address: address.toLowerCase() } : null;
}

/** The signer an order is prepared for: the agent key a request named, else the owner's wallet. */
export function orderSigner(agent: { role: 'agent'; address: string } | null, owner: string): { role: 'owner' | 'agent'; address: string } {
  return agent ?? { role: 'owner', address: owner };
}
