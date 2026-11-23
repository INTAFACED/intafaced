---------------------------- MODULE CashOutLock ----------------------------
\* One partner-held cash-out request driven by two drivers at once: the customer's call or replay, and the re-drive
\* job or another replica. Source: services/svc-bank/src/cash-out/cash-out.ts `drive`, the partner-held branch, and
\* services/svc-bank/src/session-lock.ts. Every step names the code (CASHOUT-COVERS.md).
\*
\* The request's session advisory lock is held on one reserved connection that sits idle while the body runs on the
\* pool's other connections. If that connection drops, Postgres frees the lock and the body carries on without it
\* (`LoseLock`, only when CanLose). The partner deduplicates moves on their key and keeps nothing under a key it refused.
\* The customer's money at the partner can arrive at any time.
\*
\* Fixed, the code since #8597 (`giveBackRefused`): a driver whose move was made but whose stamp found the row no longer
\* `processing` reads the row, and a `refused` one gets its money back under the request's back key
\* (`bank.cash-out-back:<id>`). Fixed = FALSE is the code before it.
EXTENDS Integers, FiniteSets
CONSTANTS Procs, CanLose, Fixed
NULL == "none"

VARIABLES
  status,   \* bank.cash_out_requests.status: "processing" | "refused" | "taken" (partner_move_id stamped)
  wasTaken, \* history: the row was once taken
  bal,      \* the customer's balance at the partner, in units of the request (the request is 1)
  arrivals, \* how many more times money may arrive (bounds the state space)
  moves,    \* moves the partner made under the request's key
  backed,   \* the money was given back under the back key
  lock,     \* who holds the session lock, or NULL
  pc, answer

vars == <<status, wasTaken, bal, arrivals, moves, backed, lock, pc, answer>>

Init == /\ status = "processing" /\ wasTaken = FALSE /\ bal = 0 /\ arrivals = 2 /\ moves = 0 /\ backed = FALSE
        /\ lock = NULL /\ pc = [p \in Procs |-> "idle"] /\ answer = [p \in Procs |-> NULL]

Go(p, l) == pc' = [pc EXCEPT ![p] = l]
Release(p) == lock' = IF lock = p THEN NULL ELSE lock

\* ---- the world ----
Arrive == /\ arrivals > 0 /\ arrivals' = arrivals - 1 /\ bal' = bal + 1
          /\ UNCHANGED <<status, wasTaken, moves, backed, lock, pc, answer>>
\* The lock's connection drops: Postgres frees the lock; its holder does not know and carries on.
LoseLock == /\ CanLose /\ lock # NULL /\ lock' = NULL
            /\ UNCHANGED <<status, wasTaken, bal, arrivals, moves, backed, pc, answer>>

\* ---- drive ----
\* withSessionAdvisoryLock: pg_advisory_lock waits until the lock is free.
Lock(p) == /\ pc[p] = "idle" /\ lock = NULL /\ lock' = p /\ Go(p, "read")
           /\ UNCHANGED <<status, wasTaken, bal, arrivals, moves, backed, answer>>
\* `this.row(id)` under the lock: not processing, return it unchanged (the lock is released on the way out).
Read(p) == /\ pc[p] = "read"
           /\ IF status = "processing" THEN Go(p, "move") /\ UNCHANGED lock ELSE Go(p, "done") /\ Release(p)
           /\ UNCHANGED <<status, wasTaken, bal, arrivals, moves, backed, answer>>
\* heldBank.move under `bank.cash-out:<id>`: a key already used answers with its move; else funds decide.
Move(p) == /\ pc[p] = "move"
           /\ IF moves > 0 THEN /\ answer' = [answer EXCEPT ![p] = "ok"] /\ UNCHANGED <<bal, moves>>
              ELSE IF bal >= 1 THEN /\ bal' = bal - 1 /\ moves' = moves + 1 /\ answer' = [answer EXCEPT ![p] = "ok"]
              ELSE /\ answer' = [answer EXCEPT ![p] = "refused"] /\ UNCHANGED <<bal, moves>>
           /\ Go(p, "record")
           /\ UNCHANGED <<status, wasTaken, arrivals, backed, lock>>
\* `moved(id, 'processing', ...)`: refused -> status = 'refused'; made -> partner_move_id stamped. Either is
\* `WHERE status = 'processing'`; no row back throws bank.ramp_conflict (the lock is released on the way out).
Record(p) ==
  /\ pc[p] = "record"
  /\ IF status = "processing"
     THEN /\ status' = (IF answer[p] = "ok" THEN "taken" ELSE "refused")
          /\ wasTaken' = (wasTaken \/ answer[p] = "ok")
          /\ Go(p, "done") /\ Release(p)
     ELSE /\ UNCHANGED <<status, wasTaken>>
          /\ IF Fixed /\ answer[p] = "ok" THEN Go(p, "giveback") /\ UNCHANGED lock ELSE Go(p, "done") /\ Release(p)
  /\ UNCHANGED <<bal, arrivals, moves, backed, answer>>
\* Fixed (`giveBackRefused`): the row was refused while this driver's move was made: the money goes back under the back key, once.
GiveBack(p) == /\ pc[p] = "giveback"
               /\ IF status = "refused" /\ ~backed THEN bal' = bal + 1 /\ backed' = TRUE ELSE UNCHANGED <<bal, backed>>
               /\ Go(p, "done") /\ Release(p)
               /\ UNCHANGED <<status, wasTaken, arrivals, moves, answer>>

\* The end: every driver has finished. It changes nothing, so the deadlock check fails any other state with no step out
\* (a driver stuck halfway with the request's money undecided).
Done == /\ \A p \in Procs : pc[p] = "done" /\ UNCHANGED vars

Next == \/ Arrive \/ LoseLock
        \/ \E p \in Procs : Lock(p) \/ Read(p) \/ Move(p) \/ Record(p) \/ GiveBack(p)
        \/ Done
Spec == Init /\ [][Next]_vars

\* ---- the rules ----
AllDone == \A p \in Procs : pc[p] \in {"idle", "done"}
\* THE PROMISE: once every driver has finished, a refused request took nothing: no move was made under its key, or the
\* money went back.
RefusedTookNothing == (AllDone /\ status = "refused") => (moves = 0 \/ backed)
\* A taken request has its move, and the money stays taken.
TakenMeansMoved == status = "taken" => moves = 1 /\ ~backed
TakenStays == wasTaken => status = "taken"
\* The partner moves the money once.
MovedOnce == moves <= 1
=============================================================================
