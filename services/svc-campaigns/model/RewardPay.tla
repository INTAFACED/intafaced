---------------------------- MODULE RewardPay ----------------------------
\* Paying owed rewards from our rewards wallet to customers' own wallets, on a chain, and booking each payment.
\* Source: services/svc-campaigns/src/reward-payer.ts (RewardPayer). Every step names the code it stands for (COVERS.md).
\*
\* Two rewards owed to ONE wallet for the SAME amount, so the chain cannot tell their transfers apart (`find` matches
\* on from, to and units only). One or two payer processes (`Procs`): one service, or two replicas. A process does one
\* reward at a time (the `paying` flag in index.ts) and can die at any step and start again idle.
EXTENDS Integers, Sequences, FiniteSets
\* The spec is the code as it is now, with #8581's fix: a transfer not found is never proof it was not taken. The line
\* tagged `fix:` is that fix; check.sh's `before-fix` run gives up on absence again and shows the finding.
CONSTANTS Procs, Rewards
NULL == 0

VARIABLES
  intent,   \* campaigns.reward_intents.state: "owed" | "paid"
  pay,      \* campaigns.reward_payments.state, "none" when there is no row
  txOf,     \* campaigns.reward_payments.chain_tx (UNIQUE), NULL when unset
  base,     \* the chain's head read before the row was written (from_block): how many transfers existed then
  late,     \* LOST_PAYMENT_AFTER_MS has passed since sent_at
  chain,    \* every transfer the chain took, in order: [o |-> reward it was sent for, s |-> status]
  booked,   \* ledger rewardPayOut posts under campaigns:reward-paid:<chainTx>: set of <<hash, reward>>
  pc, job, hold, snap

vars == <<intent, pay, txOf, base, late, chain, booked, pc, job, hold, snap>>
Hashes == 1..Len(chain)
SentFor(r) == {h \in Hashes : chain[h].o = r}   \* the transfers the chain took for reward r

Init == /\ intent = [r \in Rewards |-> "owed"] /\ pay = [r \in Rewards |-> "none"]
        /\ txOf = [r \in Rewards |-> NULL] /\ base = [r \in Rewards |-> 0] /\ late = [r \in Rewards |-> FALSE]
        /\ chain = <<>> /\ booked = {}
        /\ pc = [p \in Procs |-> "idle"] /\ job = [p \in Procs |-> NULL]
        /\ hold = [p \in Procs |-> NULL] /\ snap = [p \in Procs |-> NULL]

Go(p, l) == pc' = [pc EXCEPT ![p] = l]
Idle(p) == /\ Go(p, "idle") /\ job' = [job EXCEPT ![p] = NULL] /\ hold' = [hold EXCEPT ![p] = NULL]

\* ---- payDue (reward-payer.ts payDue) ----
\* due(): owed, no payment row. Then head() and INSERT ... ON CONFLICT (reward_key) DO NOTHING: a row exists, skip.
StartDue(p, r) ==
  /\ pc[p] = "idle" /\ intent[r] = "owed" /\ pay[r] = "none"
  /\ pay' = [pay EXCEPT ![r] = "sending"] /\ base' = [base EXCEPT ![r] = Len(chain)]
  /\ Go(p, "send") /\ job' = [job EXCEPT ![p] = r]
  /\ UNCHANGED <<intent, txOf, late, chain, booked, hold, snap>>

\* chain.send: refused before the node took it (throws), taken and answered, or taken and the answer lost (throws).
SendRefused(p) == /\ pc[p] = "send" /\ Idle(p)
                  /\ UNCHANGED <<intent, pay, txOf, base, late, chain, booked, snap>>
SendTaken(p) ==
  /\ pc[p] = "send"
  /\ chain' = Append(chain, [o |-> job[p], s |-> "pending"])
  /\ \/ /\ hold' = [hold EXCEPT ![p] = Len(chain) + 1] /\ Go(p, "write_hash") /\ UNCHANGED job
     \/ Idle(p)                                                   \* the answer was lost: `catch { continue; }`
  /\ UNCHANGED <<intent, pay, txOf, base, late, booked, snap>>
\* UPDATE reward_payments SET chain_tx = <hash> WHERE reward_key = r AND chain_tx IS NULL  (no state check)
WriteHash(p) ==
  /\ pc[p] = "write_hash"
  /\ LET r == job[p] IN
       IF txOf[r] = NULL /\ \A x \in Rewards : txOf[x] # hold[p]
       THEN txOf' = [txOf EXCEPT ![r] = hold[p]] ELSE UNCHANGED txOf
  /\ Idle(p)
  /\ UNCHANGED <<intent, pay, base, late, chain, booked, snap>>

\* ---- settleOpen / settle (reward-payer.ts settleOpen, settle, fail, book) ----
\* SELECT ... WHERE p.state IN ('sending','sent'): settle works from this snapshot of the row.
StartSettle(p, r) ==
  /\ pc[p] = "idle" /\ pay[r] \in {"sending", "sent"}
  /\ job' = [job EXCEPT ![p] = r] /\ snap' = [snap EXCEPT ![p] = pay[r]] /\ hold' = [hold EXCEPT ![p] = txOf[r]]
  /\ Go(p, IF pay[r] = "sent" THEN "book" ELSE IF txOf[r] = NULL THEN "find" ELSE "receipt")
  /\ UNCHANGED <<intent, pay, txOf, base, late, chain, booked>>

\* fail(): UPDATE reward_payments SET state = 'failed' WHERE state = 'sending' (and the reward stays owed, for a person)
FailCAS(r) == pay' = [pay EXCEPT ![r] = IF @ = "sending" THEN "failed" ELSE @]

\* The hashes already claimed, then chain.find(from, to, units, from_block): mined transfers only, oldest first, the
\* first one not claimed. None: the payment stays open, past LOST_PAYMENT_AFTER_MS too (`unconfirmed`, a reason only). Found: UPDATE chain_tx (UNIQUE: a hash
\* another row holds throws, and this payment is looked at again next pass).
Find(p) ==
  /\ pc[p] = "find"
  /\ LET r == job[p]
         claimed == {txOf[x] : x \in Rewards} \ {NULL}
         found == {h \in Hashes : h > base[r] /\ chain[h].s = "mined" /\ h \notin claimed}
     IN IF found = {}
        THEN /\ IF late[r] /\ FALSE THEN FailCAS(r) ELSE UNCHANGED pay                  \* fix: absence is not proof
             /\ Idle(p) /\ UNCHANGED txOf
        ELSE LET h == CHOOSE h \in found : \A g \in found : h <= g IN
             IF \E x \in Rewards : txOf[x] = h
             THEN /\ Idle(p) /\ UNCHANGED <<txOf, pay>>
             ELSE /\ txOf' = [txOf EXCEPT ![r] = h] /\ hold' = [hold EXCEPT ![p] = h]
                  /\ Go(p, "receipt") /\ UNCHANGED <<job, pay>>
  /\ UNCHANGED <<intent, base, late, chain, booked, snap>>

\* chain.receipt: not mined yet (null) waits; reverted fails; succeeded: UPDATE state = 'sent' (no state check).
Receipt(p) ==
  /\ pc[p] = "receipt"
  /\ LET r == job[p]  h == hold[p] IN
       CASE chain[h].s \in {"pending", "dropped"} -> /\ Idle(p) /\ UNCHANGED pay
         [] chain[h].s = "reverted"              -> /\ FailCAS(r) /\ Idle(p)
         [] chain[h].s = "mined"                 -> /\ pay' = [pay EXCEPT ![r] = "sent"] /\ Go(p, "book")
                                                    /\ UNCHANGED <<job, hold>>
  /\ UNCHANGED <<intent, txOf, base, late, chain, booked, snap>>

\* book(): ledger.post(rewardPayOut) under campaigns:reward-paid:<chainTx>; a key already booked returns its first tx.
Book(p) ==
  /\ pc[p] = "book"
  /\ booked' = IF \E b \in booked : b[1] = hold[p] THEN booked ELSE booked \cup {<<hold[p], job[p]>>}
  /\ Go(p, "mark")
  /\ UNCHANGED <<intent, pay, txOf, base, late, chain, job, hold, snap>>
\* One transaction: payment 'booked' WHERE state = 'sent'; reward 'paid' WHERE state = 'owed' AND pay_to_wallet = ...
Mark(p) ==
  /\ pc[p] = "mark"
  /\ LET r == job[p] IN
       /\ pay' = [pay EXCEPT ![r] = IF @ = "sent" THEN "booked" ELSE @]
       /\ intent' = [intent EXCEPT ![r] = "paid"]
  /\ Idle(p)
  /\ UNCHANGED <<txOf, base, late, chain, booked, snap>>

\* ---- the world ----
Crash(p) == /\ pc[p] # "idle" /\ Idle(p)                         \* the process dies; a new one starts idle
            /\ UNCHANGED <<intent, pay, txOf, base, late, chain, booked, snap>>
Tick(r) == /\ pay[r] # "none" /\ ~late[r] /\ late' = [late EXCEPT ![r] = TRUE]    \* 60 s pass since sent_at
           /\ UNCHANGED <<intent, pay, txOf, base, chain, booked, pc, job, hold, snap>>
\* A transfer the node took is mined (succeeds), reverts, or is dropped and never lands; any of them at any time.
Land(h) == /\ h \in Hashes /\ chain[h].s = "pending"
           /\ \E s \in {"mined", "reverted", "dropped"} : chain' = [chain EXCEPT ![h].s = s]
           /\ UNCHANGED <<intent, pay, txOf, base, late, booked, pc, job, hold, snap>>

Next == \/ \E p \in Procs : \/ SendRefused(p) \/ SendTaken(p) \/ WriteHash(p) \/ Find(p) \/ Receipt(p)
                            \/ Book(p) \/ Mark(p) \/ Crash(p)
                            \/ \E r \in Rewards : StartDue(p, r) \/ StartSettle(p, r)
        \/ \E r \in Rewards : Tick(r)
        \/ \E h \in Hashes : Land(h)
Spec == Init /\ [][Next]_vars
Bound == Len(chain) <= 3   \* a state constraint: the code sends at most once per reward; a broken variant may not

\* ---- the rules ----
\* THE PROMISE: a payment is given up ('failed', never sent again) only when its transfer can no longer land.
NeverGiveUpOnALiveSend == \A r \in Rewards : pay[r] = "failed" => \A h \in SentFor(r) : chain[h].s \in {"reverted", "dropped"}
\* One send per reward, however many processes and crashes.
OneSendPerReward == \A r \in Rewards : Cardinality(SentFor(r)) <= 1
\* A reward reads paid only on a transfer that succeeded, and no transfer pays two rewards.
PaidOnAMinedTransfer == \A r \in Rewards : intent[r] = "paid" => (txOf[r] # NULL /\ chain[txOf[r]].s = "mined")
OneTransferOneReward == \A r, x \in Rewards : (r # x /\ intent[r] = "paid" /\ intent[x] = "paid") => txOf[r] # txOf[x]
\* Each booking is of a transfer that succeeded, under one key per transfer.
BookedOnAMinedTransfer == \A b \in booked : chain[b[1]].s = "mined"
BookedOnce == \A b, c \in booked : b[1] = c[1] => b = c
=============================================================================
