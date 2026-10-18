# L3 pack — support agent comment write + operator claim

**Class:** N  
**Does NOT invent L1/L2.** No refunds, no balance invent in comments.

## Outcome

- Support agent may draft/post ticket comments only with approval; money-invent language refused.
- Operator exclusive claim on open/pending tickets (no steal).

## Paths

```
docs/ops/slices/L3-2026-08-05-support-agent-comment.md
services/svc-agents/src/support-agent/guardrail.ts
services/svc-agents/src/support-agent/guardrail.test.ts
services/svc-agents/src/support-agent/comment-draft.ts
services/svc-agents/src/support-agent/comment-draft.test.ts
services/svc-support/src/operator-queue.ts
services/svc-support/src/operator-queue.test.ts
packages/i18n/src/catalog.ts
```

## Board-Delta

L3 Class N: support agent comment (approval) + operator claim exclusive.
