/**
 * OPERATOR-ONLY RECORD OF AN ISOLATION DENIAL.
 *
 * "This merchant exists but is not yours" and "this merchant does not exist" are
 * the same answer to the caller (`pay.merchant_not_found`, 404): a distinct
 * refusal would let any merchant probe which ids are real. Operators still need
 * to tell the two apart, so the real reason goes here and only here. Nothing in
 * this event is ever put in a response body, message, header or error cause.
 *
 * Default sink is silent so library and test callers need no logger; `index.ts`
 * wires it to the service log.
 */
export type IsolationDenialReason =
  /** Principal is not the merchant's user, and no tree fence is wired. */
  | 'not_owner'
  /** No principal user id at all. */
  | 'anonymous'
  /** Principal has no merchant node of its own to hold a tree relation from. */
  | 'no_actor_merchant'
  /** Subject sits outside the actor's sub-merchant tree (parent, sibling, other tree). */
  | 'out_of_scope'
  /** The id does not exist. Logged too, so the two classes are comparable. */
  | 'absent';

export interface IsolationDenial {
  readonly reason: IsolationDenialReason;
  readonly merchantId: string;
  readonly principalUserId?: string;
  readonly actorMerchantId?: string;
  readonly area?: string;
}

export type IsolationDenialSink = (denial: IsolationDenial) => void;

let sink: IsolationDenialSink = () => undefined;

export function setIsolationDenialSink(next: IsolationDenialSink | null): void {
  sink = next ?? (() => undefined);
}

/** Never throws: a broken logger must not change the answer a caller gets. */
export function logIsolationDenial(denial: IsolationDenial): void {
  try {
    sink(denial);
  } catch {
    // swallowed on purpose
  }
}
