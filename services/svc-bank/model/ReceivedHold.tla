---------------------------- MODULE ReceivedHold ----------------------------
\* One payment from a stranger, held for its recipient: setting it aside, then releasing or returning it.
\* Source: services/svc-bank/src/holds/received-holds.ts (ReceivedHoldService). Every step names the code (COVERS.md).
\*
\* Two placers work on the one `placing` row: the send's own call after it posted (`placeFor`, "inline") and the
\* recovery timer (`sweep`, one at a time under its singleton lock). The recipient's available balance goes down and up
\* at any time. Each hold post is a request to the ledger that lands, is refused, or never arrives; a request lands only
\* within the in-flight bound B of the moment it was sent (POST_IN_FLIGHT_BOUND_SECONDS), which is what the code relies on.
\* One minute of the model is one period of the recovery timer (BANK_RECOVERY_JOBS_INTERVAL_MS, 60 s by default; the
\* bound is 7 of them), so the timer's pass runs at least once in every minute.
\*
\* The spec is the code as it is now, with #8586's fix. Lines tagged `fix:` are that fix: check.sh's `before-fix` run
\* takes them out and shows the finding the fix closes.
EXTENDS Integers, FiniteSets
CONSTANTS Placers, B, MaxT, Tries
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
  lapsedAt,   \* bank.received_holds.decided_at while the row is lapsed
  attemptedAt,\* bank.received_holds.attempted_at
  passAt,     \* the minute of the timer's last look at lapsed rows (sweep's second step)
  flying,     \* hold-post requests on their way to the ledger: set of [p, t]
  answer,     \* what each placer's own request got back: "none" | "ok" | "short" | "unknown"
  pc, snap, tries

vars == <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, lapsedAt, attemptedAt, passAt, flying, answer,
          pc, snap, tries>>
Procs == Placers \cup {"decider"}

Init == /\ clock = 0 /\ bal = 1 /\ moves = 2 /\ pot = 0 /\ holdKey = FALSE /\ outPosts = {}
        /\ state = "placing" /\ refusedAt = NULL /\ lapsedAt = NULL /\ attemptedAt = NULL /\ passAt = 0
        /\ flying = {} /\ answer = [p \in Placers |-> "none"] /\ pc = [p \in Procs |-> "idle"]
        /\ snap = [p \in Placers |-> NULL] /\ tries = [p \in Placers |-> 0]

Go(p, l) == pc' = [pc EXCEPT ![p] = l]

\* ---- the world ----
\* A minute passes only after the timer's pass has looked at the lapsed rows in it.
Tick == /\ clock < MaxT /\ passAt = clock /\ clock' = clock + 1
        /\ flying' = {r \in flying : clock' <= r.t + B}         \* past the bound, a request never lands
        /\ UNCHANGED <<bal, moves, pot, holdKey, outPosts, state, refusedAt, lapsedAt, attemptedAt, passAt, answer, pc,
                       snap, tries>>
Spend   == /\ moves > 0 /\ bal > 0 /\ bal' = bal - 1 /\ moves' = moves - 1
           /\ UNCHANGED <<clock, pot, holdKey, outPosts, state, refusedAt, lapsedAt, attemptedAt, passAt, flying, answer,
                          pc, snap, tries>>
Receive == /\ moves > 0 /\ bal < 2 /\ bal' = bal + 1 /\ moves' = moves - 1
           /\ UNCHANGED <<clock, pot, holdKey, outPosts, state, refusedAt, lapsedAt, attemptedAt, passAt, flying, answer,
                          pc, snap, tries>>

\* The answer reaches the placer only if it is still waiting on that request.
Answer(p, a) == answer' = IF pc[p] = "await" /\ answer[p] = "none" THEN [answer EXCEPT ![p] = a] ELSE answer
\* The ledger takes one hold request: a booked key answers its first tx; else the non-negative check decides.
Land(r) ==
  /\ r \in flying /\ flying' = flying \ {r}
  /\ IF holdKey THEN /\ UNCHANGED <<bal, pot, holdKey>> /\ Answer(r.p, "ok")
     ELSE IF bal >= 1 THEN /\ bal' = bal - 1 /\ pot' = 1 /\ holdKey' = TRUE /\ Answer(r.p, "ok")
     ELSE /\ UNCHANGED <<bal, pot, holdKey>> /\ Answer(r.p, "short")
  /\ UNCHANGED <<clock, moves, outPosts, state, refusedAt, lapsedAt, attemptedAt, passAt, pc, snap, tries>>
Lose(r) == /\ r \in flying /\ flying' = flying \ {r}                     \* the request never arrives
           /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, lapsedAt, attemptedAt, passAt,
                          answer, pc, snap, tries>>

\* ---- placing (place) ----
\* sweep: the row is read at the start of the pass (its refused_at is this snapshot); placeFor: read just before.
Start(p) == /\ pc[p] = "idle" /\ state = "placing" /\ tries[p] < Tries
            /\ snap' = [snap EXCEPT ![p] = refusedAt] /\ tries' = [tries EXCEPT ![p] = @ + 1] /\ Go(p, "attempt")
            /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, lapsedAt, attemptedAt, passAt,
                           flying, answer>>
\* UPDATE attempted_at = now WHERE state = 'placing' RETURNING: no row back, nothing is posted; else
\* ledger.post(payReceivedHold).
Attempt(p) == /\ pc[p] = "attempt"
              /\ IF state # "placing" /\ TRUE                                                 \* fix: claim
                 THEN /\ Go(p, "idle") /\ UNCHANGED <<attemptedAt, flying, answer>>
                 ELSE /\ attemptedAt' = (IF state = "placing" THEN clock ELSE attemptedAt)
                      /\ flying' = flying \cup {[p |-> p, t |-> clock]} /\ answer' = [answer EXCEPT ![p] = "none"]
                      /\ Go(p, "await")
              /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, lapsedAt, passAt, snap, tries>>
\* The call times out: the request may still be on its way.
Timeout(p) == /\ pc[p] = "await" /\ answer[p] = "none" /\ answer' = [answer EXCEPT ![p] = "unknown"]
              /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, state, refusedAt, lapsedAt, attemptedAt, passAt,
                             flying, pc, snap, tries>>
Old(t) == t # NULL /\ clock - t > B
\* markHeld: UPDATE state = 'held', decided_at = NULL WHERE state IN ('placing', 'lapsed').
HeldFrom == {"placing", "lapsed"}                                                             \* fix: un-lapse
\* After the answer: ok, or getTxByKey finds the key booked: markHeld. Else a definite short refusal whose refused_at
\* (the snapshot) is older than B: placing -> lapsed. Else refused_at := short ? (snapshot ?? now) : null.
Decide(p) ==
  /\ pc[p] = "await" /\ answer[p] # "none"
  /\ IF answer[p] = "ok" \/ holdKey
     THEN /\ state' = (IF state \in HeldFrom THEN "held" ELSE state)
          /\ lapsedAt' = (IF state \in HeldFrom THEN NULL ELSE lapsedAt) /\ UNCHANGED refusedAt
     ELSE IF answer[p] = "short" /\ Old(snap[p])
     THEN /\ state' = (IF state = "placing" THEN "lapsed" ELSE state)
          /\ lapsedAt' = (IF state = "placing" THEN clock ELSE lapsedAt) /\ UNCHANGED refusedAt
     ELSE /\ refusedAt' = IF state # "placing" THEN refusedAt
                          ELSE IF answer[p] = "short" THEN (IF snap[p] = NULL THEN clock ELSE snap[p]) ELSE NULL
          /\ UNCHANGED <<state, lapsedAt>>
  /\ Go(p, "idle")
  /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, attemptedAt, passAt, flying, answer, snap, tries>>

\* ---- the timer's look at lapsed rows (sweep's second step) ----
\* SELECT lapsed rows WHERE decided_at > now - 2B; getTxByKey(pay.recv.hold:<id>) booked: markHeld. The read and the
\* key lookup are taken as one step: a row only ever leaves `lapsed` for `held`, and a booked key stays booked.
Window == 2 * B
Heal == /\ passAt' = clock
        /\ IF state = "lapsed" /\ clock - lapsedAt < Window /\ holdKey /\ TRUE                \* fix: heal
           THEN state' = "held" /\ lapsedAt' = NULL
           ELSE UNCHANGED <<state, lapsedAt>>
        /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, refusedAt, attemptedAt, flying, answer, pc, snap, tries>>

\* ---- answering (decideHold, the release date, finish) ----
\* The recipient's Accept or Deny, or the release date: claim held -> releasing | returning, then post that outcome.
Claim(o) == /\ pc["decider"] = "idle" /\ state = "held"
            /\ state' = (IF o = "release" THEN "releasing" ELSE "returning") /\ Go("decider", "finish")
            /\ UNCHANGED <<clock, bal, moves, pot, holdKey, outPosts, refusedAt, lapsedAt, attemptedAt, passAt, flying,
                           answer, snap, tries>>
Finish == /\ pc["decider"] = "finish" /\ state \in {"releasing", "returning"}
          /\ LET o == IF state = "releasing" THEN "release" ELSE "return" IN
               IF o \in outPosts \/ pot >= 1
               THEN /\ pot' = (IF o \in outPosts THEN pot ELSE pot - 1) /\ outPosts' = outPosts \cup {o}
                    /\ state' = (IF state = "releasing" THEN "released" ELSE "returned")
               ELSE UNCHANGED <<pot, outPosts, state>>               \* refused (the pot is empty): it throws, still claimed
          /\ Go("decider", "idle")
          /\ UNCHANGED <<clock, bal, moves, holdKey, refusedAt, lapsedAt, attemptedAt, passAt, flying, answer, snap,
                         tries>>

Next == \/ Tick \/ Spend \/ Receive \/ \E r \in flying : Land(r) \/ Lose(r)
        \/ \E p \in Placers : Start(p) \/ Attempt(p) \/ Timeout(p) \/ Decide(p)
        \/ Heal
        \/ \E o \in {"release", "return"} : Claim(o)
        \/ Finish
Spec == Init /\ [][Next]_vars

\* ---- the rules ----
\* THE PROMISE: money set aside for a held payment can always be reached. A row lapsed while its hold was still on its
\* way may hold the money for a moment; the timer puts it back to `held` while it is still in its window, so no row holds
\* the money as `lapsed` once that window has passed.
NeverStranded == (pot >= 1 /\ state = "lapsed") => clock - lapsedAt < Window
\* Not a rule: shown broken to prove the code does reach a lapsed row holding the money, so NeverStranded is not empty.
LapsedNeverHoldsMoney == ~(pot >= 1 /\ state = "lapsed")
\* A row past placing that is not lapsed has its hold booked: a row is never put back to held without the money.
HeldHasHold == state \in {"held", "releasing", "returning", "released", "returned"} => holdKey
\* The hold is booked once, and the payment ends one way: released or returned, never both.
HoldOnce == pot <= 1
OneOutcome == Cardinality(outPosts) <= 1
OutcomeMatches == /\ "release" \in outPosts => state \in {"releasing", "released"}
                  /\ "return" \in outPosts => state \in {"returning", "returned"}
=============================================================================
