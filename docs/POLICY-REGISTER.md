# Policy register

This is the list of product and money-safety rules that are in force right now, one row per rule. It answers "what is the rule today?" at a glance. The decision record linked in each row answers "why?".

How it works:

- **Only accepted decision records bind.** Every row must link a record in [`adr/`](adr/README.md) whose status is `accepted`. A proposed or superseded record cannot back a rule. A CI check fails the build if a row points at a missing or non-accepted record, or if the [record index](adr/README.md) is out of date.
- **Hard or soft.** A hard rule is never crossed; breaking it means stopping the action. A soft rule is a limit that triggers a review or an escalation when crossed.
- **To change a rule,** write a new decision record from [`adr/TEMPLATE.md`](adr/TEMPLATE.md) that supersedes the old one, then update the row here in the same pull request. Never edit the old record's decision. Agents make these calls and record them here, so Phantom can see what was decided and why.
- **Review by** is the date the rule is looked at again, even if nothing went wrong.

Example row, for shape only (it is not a rule): `| Transfers to a new payee need a second factor | second factor on the first transfer | hard | chat 3 1 | [ADR](adr/2026-10-14-example.md) | 2026-10-14 | 2027-01-14 |`

| Rule | Current value | Hard/soft | Owner chat | ADR | Effective | Review by |
| ---- | ------------- | --------- | ---------- | --- | --------- | --------- |
