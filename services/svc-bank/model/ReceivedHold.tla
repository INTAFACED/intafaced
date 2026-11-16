---------------------------- MODULE ReceivedHold ----------------------------
\* One payment from a stranger, held for its recipient: setting it aside, then releasing or returning it.
\* Source: services/svc-bank/src/holds/received-holds.ts (ReceivedHoldService). Every step names the code (COVERS.md).
\*
\* Two placers work on the one `placing` row: the send's own call after it posted (`placeFor`, "inline") and the
\* recovery timer (`sweep`, one at a time under its singleton lock). The recipient's available balance goes down and up
\* at any time. Each hold post is a request to the ledger that lands, is refused, or never arrives; a request lands only
\* within the in-flight bound B of the moment it was sent (POST_IN_FLIGHT_BOUND_SECONDS), which is what the code relies on.
EXTENDS Integers, FiniteSets
CONSTANTS Placers, B, MaxT, Tries, StrictLapse
\* StrictLapse, the proposed fix: a placer posts only when its attempt claimed the row still placing, and the lapse
\* (one conditional update) also requires the stored attempted_at to be older than the bound.
NULL == -1

VARIABLES
  clock,      \* minutes, abstract
  bal,        \* the recipient's available balance, in units of the payment (the payment is 1)
  moves,      \* how many balance changes are left (bounds the state space)
  pot,        \* pay:recv:<transferId>, the recipient's own pot that holds the payment
  holdKey,    \* pay.recv.hold:<transferId> is booked
  outPosts,   \* outcome posts booked: subset of {"release", "return"}
  state,      \* bank.received_holds.state
  refusedAt,  \* bank.received_holds.refused_at
  attemptedAt,\* bank.received_holds.attempted_at
  flying,     \* hold-post requests on their way to the ledger: set of [p, t]
  answer,     \* what each placer's own request got back: "none" | "ok" | "short" | "unknown"
  pc, snap, tries

vars == <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, attemptedAt, flying, answer, pc, snap, tries>>
Procs == Placers \cup {"decider"}

Init == /\ clock = 0 /\ bal = 1 /\ moves = 2 /\ pot = 0 /\ holdKey = FALSE /\ outPosts = {}
        /\ state = "placing" /\ refusedAt = NULL /\ attemptedAt = NULL /\ flying = {}
        /\ answer = [p \in Placers |-> "none"] /\ pc = [p \in Procs |-> "idle"]
        /\ snap = [p \in Placers |-> NULL] /\ tries = [p \in Placers |-> 0]

Go(p, l) == pc' = [pc EXCEPT ![p] = l]

\* ---- the world ----
Tick == /\ clock < MaxT /\ clock' = clock + 1
        /\ flying' = {r \in flying : clock' <= r.t + B}         \* past the bound, a request never lands
        /\ UNCHANGED <<bal, moves, pot, holdKey, outPosts, state, refusedAt, attemptedAt, answer, pc, snap, tries>>
Spend   == /\ moves > 0 /\ bal > 0 /\ bal' = bal - 1 /\ moves' = moves - 1
           /\ UNCHANGED <<clock, pot, holdKey, outPosts, state, refusedAt, attemptedAt, flying, answer, pc, snap, tries>>
Receive == /\ moves > 0 /\ bal < 2 /\ bal' = bal + 1 /\ moves' = moves - 1
           /\ UNCHANGED <<clock, pot, holdKey, outPosts, state, refusedAt, attemptedAt, flying, answer, pc, snap, tries>>

\* The answer reaches the placer only if it is still waiting on that request.
Answer(p, a) == answer' = IF pc[p] = "await" /\ answer[p] = "none" THEN [answer EXCEPT ![p] = a] ELSE answer
\* The ledger takes one hold request: a booked key answers its first tx; else the non-negative check decides.
Land(r) ==
  /\ r \in flying /\ flying' = flying \ {r}
  /\ IF holdKey THEN /\ UNCHANGED <<bal, pot, holdKey>> /\ Answer(r.p, "ok")
     ELSE IF bal >= 1 THEN /\ bal' = bal - 1 /\ pot' = 1 /\ holdKey' = TRUE /\ Answer(r.p, "ok")
     ELSE /\ UNCHANGED <<bal, pot, holdKey>> /\ Answer(r.p, "short")
  /\ UNCHANGED <<clock, moves, outPosts, state, refusedAt, attemptedAt, pc, snap, tries>>
Lose(r) == /\ r \in flying /\ flying' = flying \ {r}                     \* the request never arrives
           /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, attemptedAt, answer, pc, snap, tries>>

\* ---- placing (place) ----
\* sweep: the row is read at the start of the pass (its refused_at is this snapshot); placeFor: read just before.
Start(p) == /\ pc[p] = "idle" /\ state = "placing" /\ tries[p] < Tries
            /\ snap' = [snap EXCEPT ![p] = refusedAt] /\ tries' = [tries EXCEPT ![p] = @ + 1] /\ Go(p, "attempt")
            /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, attemptedAt, flying, answer>>
\* UPDATE attempted_at = now WHERE state = 'placing'; then ledger.post(payReceivedHold)
\* The code posts whether or not that update found the row still placing; StrictLapse posts only if it did.
Attempt(p) == /\ pc[p] = "attempt"
              /\ IF StrictLapse /\ state # "placing"
                 THEN /\ Go(p, "idle") /\ UNCHANGED <<attemptedAt, flying, answer>>
                 ELSE /\ attemptedAt' = (IF state = "placing" THEN clock ELSE attemptedAt)
                      /\ flying' = flying \cup {[p |-> p, t |-> clock]} /\ answer' = [answer EXCEPT ![p] = "none"]
                      /\ Go(p, "await")
              /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, snap, tries>>
\* The call times out: the request may still be on its way.
Timeout(p) == /\ pc[p] = "await" /\ answer[p] = "none" /\ answer' = [answer EXCEPT ![p] = "unknown"]
              /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, attemptedAt, flying, pc, snap, tries>>
Old(t) == t # NULL /\ clock - t > B
\* After the answer: ok, or getTxByKey finds the key booked: placing -> held. Else a definite short refusal whose
\* refused_at (the snapshot) is older than B: placing -> lapsed (StrictLapse: and attempted_at, read in the same update). Else refused_at := short ? (snapshot ?? now) : null.
Decide(p) ==
  /\ pc[p] = "await" /\ answer[p] # "none"
  /\ IF answer[p] = "ok" \/ holdKey
     THEN /\ state' = (IF state = "placing" THEN "held" ELSE state) /\ UNCHANGED refusedAt
     ELSE IF answer[p] = "short" /\ Old(snap[p]) /\ (StrictLapse => Old(attemptedAt))
     THEN /\ state' = (IF state = "placing" THEN "lapsed" ELSE state) /\ UNCHANGED refusedAt
     ELSE /\ refusedAt' = IF state # "placing" THEN refusedAt
                          ELSE IF answer[p] = "short" THEN (IF snap[p] = NULL THEN clock ELSE snap[p]) ELSE NULL
          /\ UNCHANGED state
  /\ Go(p, "idle")
  /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, attemptedAt, flying, answer, snap, tries>>

\* ---- answering (decideHold, the release date, finish) ----
\* The recipient's Accept or Deny, or the release date: claim held -> releasing | returning, then post that outcome.
Claim(o) == /\ pc["decider"] = "idle" /\ state = "held"
            /\ state' = (IF o = "release" THEN "releasing" ELSE "returning") /\ Go("decider", "finish")
            /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, refusedAt, attemptedAt, flying, answer, snap, tries>>
Finish == /\ pc["decider"] = "finish" /\ state \in {"releasing", "returning"}
          /\ LET o == IF state = "releasing" THEN "release" ELSE "return" IN
               IF o \in outPosts \/ pot >= 1
               THEN /\ pot' = (IF o \in outPosts THEN pot ELSE pot - 1) /\ outPosts' = outPosts \cup {o}
                    /\ state' = (IF state = "releasing" THEN "released" ELSE "returned")
               ELSE UNCHANGED <<pot, outPosts, state>>               \* refused (the pot is empty): it throws, still claimed
          /\ Go("decider", "idle")
          /\ UNCHANGED <<clock, bal, moves, holdKey, refusedAt, attemptedAt, flying, answer, snap, tries>>

Next == \/ Tick \/ Spend \/ Receive \/ \E r \in flying : Land(r) \/ Lose(r)
        \/ \E p \in Placers : Start(p) \/ Attempt(p) \/ Timeout(p) \/ Decide(p)
        \/ \E o \in {"release", "return"} : Claim(o)
        \/ Finish
Spec == Init /\ [][Next]_vars

\* ---- the rules ----
\* THE PROMISE: money set aside for a held payment can always be reached. Once the hold lands, the row is never lapsed.
NeverStranded == (pot >= 1) => state \in {"placing", "held", "releasing", "returning"}
\* The hold is booked once, and the payment ends one way: released or returned, never both.
HoldOnce == pot <= 1
OneOutcome == Cardinality(outPosts) <= 1
OutcomeMatches == /\ "release" \in outPosts => state \in {"releasing", "released"}
                  /\ "return" \in outPosts => state \in {"returning", "returned"}
=============================================================================
