# Money journey coverage table — V2

| Journey            | Invariant                                          | Crash points                                      | V2 status                                                          |
| ------------------ | -------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| User withdraw      | hold → rail → settle OR reverse; balance conserved | reverse without failed status; double attempt key | **L3-1 fixed** — stamp failure_code then finalize reverse          |
| Token stake        | no active/unfunded stake; stakeOf = active only    | ledger without row; row without ledger            | **L3-2 fixed** — pending → post → active; delete pending on refuse |
| Earn deposit       | no active/unfunded position; interest only active  | same as stake                                     | **L3-3 fixed** — same pattern                                      |
| Pay capture/refund | ownership of merchant                              | IDOR                                              | **wave-1 fixed**                                                   |
| Deposit credit     | rail first, claim before book                      | double credit                                     | prior design (inbound)                                             |
