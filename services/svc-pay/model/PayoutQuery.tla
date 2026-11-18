---------------------------- MODULE PayoutQuery ----------------------------
\* One merchant payout on a chain: the payer sends it, and a reconciler that finds it dispatched with no answer asks the
\* chain about its key and, on `not_sent`, gives the held money back. Source: services/svc-pay/src/payment-service/
\* payouts.ts (`payoutSettlement`, `reconcileDispatchedPayout`), rails/evm-chain.ts (`send`, `lookupSend`),
\* rails/durable-broadcast.ts and rails/broadcast-store.ts. Every step names the code (COVERS.md).
\*
\* Both take the payout's session lock (`withPayoutLock`). The payer's body runs on the lock's own connection, so a
\* dropped connection frees the lock without the payer noticing while it is inside the rail call (`LoseLock`, only when
\* CanLose). The payer can also die at any step and be started again once (a retry of the payout).
\*
\* Fixed, the proposed fix: `not_sent` closes the key. The status query takes the key's claim itself (the same INSERT ...
\* ON CONFLICT DO NOTHING the send uses): won, nothing was or ever will be sent under it and the answer is `not_sent`;
\* lost, a send holds it and the answer is `unknown` until it has a hash. A send that finds the key closed sends nothing.
EXTENDS Integers
CONSTANTS CanLose, Fixed
NULL == "none"

VARIABLES
  claimed,    \* pay.crypto_broadcasts row for the key exists (__pending__ or more)
  closed,     \* Fixed: the key was claimed by a not_sent answer
  signed,     \* signed bytes journalled (putSigned)
  signs,      \* how many transactions were signed for the key
  sent,       \* the transaction left for the chain (eth_sendRawTransaction)
  hashed,     \* the hash journalled (put)
  dispatched, \* pay.payout_outcomes 'dispatched' marker committed
  reversals,  \* reverse posts that moved the held money back
  failed,     \* settlement marked failed (reversed)
  lock,       \* who holds the payout lock
  ppc, rpc, restarts

chainVars == <<claimed, closed, signed, signs, sent, hashed>>
vars == <<chainVars, dispatched, reversals, failed, lock, ppc, rpc, restarts>>

Init == /\ claimed = FALSE /\ closed = FALSE /\ signed = FALSE /\ signs = 0 /\ sent = FALSE /\ hashed = FALSE
        /\ dispatched = FALSE /\ reversals = 0 /\ failed = FALSE /\ lock = NULL /\ ppc = "idle" /\ rpc = "idle"
        /\ restarts = 1

Free(p) == lock' = IF lock = p THEN NULL ELSE lock
Step(from, to) == ppc = from /\ ppc' = to

\* The lock's connection drops: Postgres frees it; the payer, inside the rail call, carries on.
LoseLock == /\ CanLose /\ lock = "payer" /\ ppc \in {"claim", "sign", "putSigned", "broadcast", "put"} /\ lock' = NULL
            /\ UNCHANGED <<chainVars, dispatched, reversals, failed, ppc, rpc, restarts>>

\* ---- the payer (payoutSettlement, then adapter.payout -> chain.send -> runDurableBroadcast) ----
PLock == /\ ppc = "idle" /\ lock = NULL /\ ~failed /\ ~hashed /\ lock' = "payer" /\ ppc' = "mark"
         /\ UNCHANGED <<chainVars, dispatched, reversals, failed, rpc, restarts>>
\* The hold is posted and the 'dispatched' marker committed before the rail is asked. A settlement already failed stops.
PMark == /\ ppc = "mark"
         /\ IF failed THEN (ppc' = "idle" /\ Free("payer") /\ UNCHANGED dispatched)
            ELSE (dispatched' = TRUE /\ ppc' = "claim" /\ UNCHANGED lock)
         /\ UNCHANGED <<chainVars, reversals, failed, rpc, restarts>>
\* store.claim: `mine` for a fresh key; a closed key sends nothing; `done` with a hash; `resume` with signed bytes; a
\* key pending with neither stalls and throws.
PClaim == /\ ppc = "claim"
          /\ IF ~claimed THEN (claimed' = TRUE /\ ppc' = "sign")
             ELSE IF closed \/ hashed THEN (ppc' = "end" /\ UNCHANGED claimed)
             ELSE IF signed THEN (ppc' = "broadcast" /\ UNCHANGED claimed)
             ELSE (ppc' = "end" /\ UNCHANGED claimed)                     \* claim stalled while pending: it throws
          /\ UNCHANGED <<closed, signed, signs, sent, hashed, dispatched, reversals, failed, lock, rpc, restarts>>
PSign == /\ Step("sign", "putSigned") /\ signs' = signs + 1
         /\ UNCHANGED <<claimed, closed, signed, sent, hashed, dispatched, reversals, failed, lock, rpc, restarts>>
PPutSigned == /\ Step("putSigned", "broadcast") /\ signed' = TRUE
              /\ UNCHANGED <<claimed, closed, signs, sent, hashed, dispatched, reversals, failed, lock, rpc, restarts>>
PBroadcast == /\ Step("broadcast", "put") /\ sent' = TRUE
              /\ UNCHANGED <<claimed, closed, signed, signs, hashed, dispatched, reversals, failed, lock, rpc, restarts>>
PPut == /\ Step("put", "end") /\ hashed' = TRUE
        /\ UNCHANGED <<claimed, closed, signed, signs, sent, dispatched, reversals, failed, lock, rpc, restarts>>
PEnd == /\ Step("end", "idle") /\ Free("payer") /\ restarts' = 0
        /\ UNCHANGED <<chainVars, dispatched, reversals, failed, rpc>>
\* The payer dies at any step; the lock goes with its connection. A retry may start it again.
PCrash == /\ ppc \notin {"idle", "dead"}
          /\ ppc' = (IF restarts > 0 THEN "idle" ELSE "dead")
          /\ restarts' = (IF restarts > 0 THEN restarts - 1 ELSE 0)
          /\ Free("payer")
          /\ UNCHANGED <<chainVars, dispatched, reversals, failed, rpc>>

\* ---- the reconciler (reconcileDispatchedPayout) ----
RLock == /\ rpc = "idle" /\ lock = NULL /\ dispatched /\ ~failed /\ lock' = "reconciler" /\ rpc' = "query"
         /\ UNCHANGED <<chainVars, dispatched, reversals, failed, ppc, restarts>>
\* lookupSend: a hash -> sent; signed bytes -> unknown; else not_sent. Fixed: a key a send has claimed -> unknown, and a
\* not_sent answer takes the claim (closes the key) in the same step.
Answer == IF hashed THEN "sent" ELSE IF signed THEN "unknown"
          ELSE IF Fixed /\ claimed /\ ~closed THEN "unknown" ELSE "not_sent"
\* not_sent: post the reverse (keyed: once) and mark the settlement failed. sent: it finishes. unknown: the hold stays.
RQuery == /\ rpc = "query"
          /\ IF Answer = "not_sent" /\ ~failed
             THEN (/\ reversals' = (IF reversals = 0 THEN 1 ELSE reversals) /\ failed' = TRUE
                   /\ closed' = (closed \/ Fixed) /\ claimed' = (claimed \/ Fixed))
             ELSE UNCHANGED <<reversals, failed, closed, claimed>>
          /\ rpc' = "done" /\ Free("reconciler")
          /\ UNCHANGED <<signed, signs, sent, hashed, dispatched, ppc, restarts>>

Next == \/ LoseLock \/ PLock \/ PMark \/ PClaim \/ PSign \/ PPutSigned \/ PBroadcast \/ PPut \/ PEnd \/ PCrash
        \/ RLock \/ RQuery
Spec == Init /\ [][Next]_vars

\* ---- the rules ----
\* THE PROMISE: a payout is never both sent and given back.
NeverPaidTwice == ~(sent /\ reversals > 0)
\* The money goes back once, and one transaction is signed for the key.
ReversedOnce == reversals <= 1
SignedOnce == signs <= 1
=============================================================================
