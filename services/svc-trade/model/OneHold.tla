---------------------------- MODULE OneHold ----------------------------
\* One resting order M with a hold of H, one fill of Q against it, and every path that closes M's hold.
\* What it checks: money held for an order is never released while the engine has matched part of that
\* order and that fill is not yet settled (#8560), the hold is conserved, and a fill is paid once.
\* What it covers, and the commit it was last confirmed at: COVERS.md beside this file.
EXTENDS Integers
CONSTANTS H, Q, R, Paths      \* hold, fill qty, redelivery budget, closers in play
Closers == {"user", "mass", "stp", "expiry", "sweep"}
\*   user   a person's cancel                       order-change.ts cancelOrder
\*   mass   "cancel all" on one market               order-change.ts massCancelOrders
\*   stp    a self-trade pull in a submit's answer   fills.ts settleOutcome
\*   expiry an IOC/market remainder or an expiry     ioc-place.ts, gtd-gtt-place.ts, option-place.ts
\*   sweep  the operator's reconcile of a live order reconcile.ts reconcileOrder
ASSUME Q > 0 /\ Q < H /\ R >= 1 /\ Paths \subseteq Closers

Procs == {"S", "FC", "CC"} \cup Paths   \* S the taker's inline settle (fills.ts applySubmitResult);
                                        \* FC the fill consumer (events.ts settleFillEvent);
                                        \* CC the cancel consumer (events.ts releaseOnCancelEvent)
NULL == -1
Ends == {"done", "dead", "failed", "parked"}

VARIABLES
  book,         \* M's remaining qty on the engine book
  printed,      \* the engine printed the fill against M
  engCancelled, engLeft,  \* the engine took M off, and the remainder it reported
  rows,         \* M's maker leg row in trade.fills                    (fills.ts insertFillLeg)
  pot,          \* balance of M's order-hold account at the ledger
  fillPosts,    \* tradeFill movements under key trade.fill:<id>
  released, booked,       \* order.release:<id>:0 amount, and whether that key is booked (holds.ts finalize)
  status,       \* trade.orders.status
  leftCol,      \* trade.orders.engine_left_qty, NULL = -1
  lock,         \* holder of SELECT ... FOR UPDATE on M's row          (holds.ts finalize)
  pc, sumRead, amt, tries

vars == <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released, booked,
          status, leftCol, lock, pc, sumRead, amt, tries>>

Start(p) == IF p \in {"S", "FC", "CC"} THEN "wait" ELSE "engine_cancel"

Init == /\ book = H /\ printed = FALSE /\ engCancelled = FALSE /\ engLeft = 0
        /\ rows = FALSE /\ pot = H /\ fillPosts = 0 /\ released = 0 /\ booked = FALSE
        /\ status = "open" /\ leftCol = NULL /\ lock = "none"
        /\ pc = [p \in Procs |-> Start(p)] /\ sumRead = [p \in Procs |-> 0]
        /\ amt = [p \in Procs |-> 0] /\ tries = [p \in Procs |-> 0]

Go(p, l) == pc' = [pc EXCEPT ![p] = l]

\* ---- the engine (one serial book per market) ----
Match == /\ ~printed /\ ~engCancelled /\ book >= Q
         /\ printed' = TRUE /\ book' = book - Q
         /\ UNCHANGED <<engCancelled, engLeft, rows, pot, fillPosts, released, booked,
                        status, leftCol, lock, pc, sumRead, amt, tries>>

\* ---- a handler throws: a consumer is redelivered, a request just fails ----
Throw(p, retryAt) ==
  IF p \in {"FC", "CC"} /\ tries[p] < R
  THEN /\ tries' = [tries EXCEPT ![p] = @ + 1] /\ Go(p, retryAt)
  ELSE /\ UNCHANGED tries /\ Go(p, IF p \in {"FC", "CC"} THEN "parked" ELSE "failed")

\* ---- settle: S and FC (fills.ts settleFill) ----
SettleStart(p) == /\ p \in {"S", "FC"} /\ pc[p] = "wait" /\ printed /\ Go(p, "row")
                  /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                                 booked, status, leftCol, lock, sumRead, amt, tries>>
SettleRow(p) == /\ pc[p] = "row" /\ rows' = TRUE /\ Go(p, "post")
                /\ UNCHANGED <<book, printed, engCancelled, engLeft, pot, fillPosts, released,
                               booked, status, leftCol, lock, sumRead, amt, tries>>
SettlePost(p) ==
  /\ pc[p] = "post"
  /\ IF fillPosts > 0 THEN /\ Go(p, "done") /\ UNCHANGED <<pot, fillPosts, tries>>
     ELSE IF pot >= Q THEN /\ pot' = pot - Q /\ fillPosts' = fillPosts + 1 /\ Go(p, "done") /\ UNCHANGED tries
     ELSE /\ Throw(p, "row") /\ UNCHANGED <<pot, fillPosts>>
  /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, released, booked, status, leftCol, lock, sumRead, amt>>
Redeliver == /\ pc["FC"] = "done" /\ tries["FC"] < R
             /\ tries' = [tries EXCEPT !["FC"] = @ + 1] /\ Go("FC", "row")
             /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                            booked, status, leftCol, lock, sumRead, amt>>
CrashS == /\ pc["S"] \in {"row", "post"} /\ Go("S", "dead")
          /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                         booked, status, leftCol, lock, sumRead, amt, tries>>

\* ---- closers: the engine takes M off and reports what was left; the closer keeps it, then finalizes ----
EngineCancel(p) ==
  /\ p \in Paths /\ pc[p] = "engine_cancel"
  /\ IF book > 0 /\ ~engCancelled
     THEN /\ engCancelled' = TRUE /\ engLeft' = book /\ book' = 0 /\ Go(p, "write_left")
     ELSE /\ Go(p, "done") /\ UNCHANGED <<engCancelled, engLeft, book>>   \* a miss never releases
  /\ UNCHANGED <<printed, rows, pot, fillPosts, released, booked, status, leftCol, lock, sumRead, amt, tries>>
CCStart == /\ pc["CC"] = "wait" /\ engCancelled /\ Go("CC", "write_left")
           /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                          booked, status, leftCol, lock, sumRead, amt, tries>>
WriteLeft(p) == /\ pc[p] = "write_left"
                /\ leftCol' = (IF leftCol = NULL THEN engLeft ELSE leftCol) /\ Go(p, "fin_lock")
                /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                               booked, status, lock, sumRead, amt, tries>>

\* The remainder each closer hands finalize: a person's cancel reads the stored first answer, the others
\* pass the engine's answer or event they hold.
LeftOf(p) == IF p = "user" THEN leftCol ELSE engLeft
\* Which closers pass it at all. Every one does; a broken variant takes some out.
Evidenced == Closers \cup {"CC"}

\* ---- finalize (holds.ts finalize) ----
FinLock(p) == /\ pc[p] = "fin_lock" /\ lock = "none"
              /\ IF status = "open" THEN /\ lock' = p /\ Go(p, "fin_guard")
                 ELSE /\ UNCHANGED lock /\ Go(p, "done")
              /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                             booked, status, leftCol, sumRead, amt, tries>>
FinGuard(p) ==                     \* refuses while fewer fills are written than the engine matched
  /\ pc[p] = "fin_guard"
  /\ LET engineFilled == H - LeftOf(p)
         recorded     == IF rows THEN Q ELSE 0
     IN IF p \in Evidenced /\ engineFilled > 0 /\ recorded < engineFilled
        THEN /\ lock' = "none"
             /\ IF p = "CC" THEN Throw(p, "write_left") ELSE /\ Go(p, "done") /\ UNCHANGED tries
        ELSE /\ Go(p, "fin_sum") /\ UNCHANGED <<lock, tries>>
  /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released, booked, status, leftCol, sumRead, amt>>
FinSum(p) == /\ pc[p] = "fin_sum" /\ sumRead' = [sumRead EXCEPT ![p] = IF rows THEN Q ELSE 0]
             /\ Go(p, "fin_pot")
             /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                            booked, status, leftCol, lock, amt, tries>>
FinPot(p) == /\ pc[p] = "fin_pot"
             /\ amt' = [amt EXCEPT ![p] = IF booked THEN released
                                          ELSE IF pot < H - sumRead[p] THEN pot ELSE H - sumRead[p]]
             /\ Go(p, "fin_post")
             /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                            booked, status, leftCol, lock, sumRead, tries>>
FinPost(p) ==
  /\ pc[p] = "fin_post"
  /\ IF amt[p] = 0 \/ booked THEN /\ Go(p, "fin_status") /\ UNCHANGED <<pot, released, booked, lock, tries>>
     ELSE IF amt[p] <= pot
          THEN /\ pot' = pot - amt[p] /\ released' = amt[p] /\ booked' = TRUE
               /\ Go(p, "fin_status") /\ UNCHANGED <<lock, tries>>
          ELSE /\ lock' = "none" /\ Throw(p, "write_left") /\ UNCHANGED <<pot, released, booked>>
  /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, fillPosts, status, leftCol, sumRead, amt>>
FinStatus(p) == /\ pc[p] = "fin_status" /\ status' = "cancelled" /\ lock' = "none" /\ Go(p, "done")
                /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released,
                               booked, leftCol, sumRead, amt, tries>>
CrashFin(p) ==
  /\ pc[p] \in {"fin_guard", "fin_sum", "fin_pot", "fin_post", "fin_status"}
  /\ lock' = "none"
  /\ IF p = "CC" THEN Throw(p, "write_left") ELSE /\ Go(p, "dead") /\ UNCHANGED tries
  /\ UNCHANGED <<book, printed, engCancelled, engLeft, rows, pot, fillPosts, released, booked, status, leftCol, sumRead, amt>>

Next == \/ Match \/ CrashS \/ Redeliver \/ CCStart
        \/ \E p \in Procs : \/ SettleStart(p) \/ SettleRow(p) \/ SettlePost(p)
                            \/ EngineCancel(p) \/ WriteLeft(p) \/ FinLock(p) \/ FinGuard(p)
                            \/ FinSum(p) \/ FinPot(p) \/ FinPost(p) \/ FinStatus(p) \/ CrashFin(p)
Spec == Init /\ [][Next]_vars

\* ---- the rules ----
Conservation    == pot + released + fillPosts * Q = H
PaysOnce        == fillPosts <= 1
NoReleaseOfOwed == released <= H - (IF printed THEN Q ELSE 0)
Quiet == \A p \in Procs : pc[p] \in Ends \/ (pc[p] = "wait" /\ ~ENABLED (SettleStart(p) \/ CCStart))
EveryFillPaid   == Quiet => (printed => fillPosts = 1)
=============================================================================

THIS IS NOT TLA+ ===
