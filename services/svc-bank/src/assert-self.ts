import { TRPCError } from '@intafaced/contracts';

/**
 * A principal may only ever act on its own money, whatever its scopes say.
 *
 * WHY FORBIDDEN AND NOT NOT_FOUND. The trade-off is real and goes the other
 * way on the first reading: NOT_FOUND leaks strictly less, because it never
 * confirms that the id exists. We take FORBIDDEN anyway.
 *
 *   · It is the truth. Every id this guards is a v4 uuid the client already
 *     holds, so the overwhelmingly common way to reach this line is a user or
 *     an integration passing the wrong one. Telling them "no such schedule"
 *     sends them hunting for a record that is alive and well, and it is a lie
 *     we would have to keep telling in the logs too.
 *
 *   · The oracle it opens is worth almost nothing here. 122 bits of entropy
 *     means the id space is not enumerable, so FORBIDDEN discloses exactly one
 *     fact: a uuid the caller ALREADY OBTAINED belongs to someone else. An
 *     attacker who has the id has, by construction, already been somewhere they
 *     could see it.
 *
 * svc-agents' `ownedSession` makes the opposite call and returns NOT_FOUND for
 * both cases. That is a defensible reading of the same trade-off. What is not
 * defensible is doing both inside one service, so every ownership refusal in
 * svc-bank goes through this function and every one of them is FORBIDDEN.
 */
export function assertSelf(principalUserId: string | undefined, ownerId: string): void {
  if (principalUserId !== ownerId) {
    // Note what this message does NOT contain: no name, no asset, no balance,
    // no id. The refusal-shape ADR's rule — a refusal may only describe objects
    // the caller was already entitled to see — is satisfied by this sentence in
    // either reading of the code above it. What the ADR would additionally
    // prefer is the CODE: `NOT_FOUND` rather than `FORBIDDEN`, so that "not
    // yours" cannot confirm an id. That is a change to who may see what, which
    // the ADR reserves to the owner, and this service argued the opposite case
    // in writing first. It stays FORBIDDEN, uniformly, until the owner moves it.
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This account belongs to another user' });
  }
}
