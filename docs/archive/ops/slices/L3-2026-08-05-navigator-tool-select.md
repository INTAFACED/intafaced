# L3 pack — navigator tool_select pure planner

**Class:** N  
**Does NOT invent L1/L2.** No prices, no money-write tools, no dark-plane invent.

## Outcome

`navigator.tool_select` has a pure planner: intersect candidates with Stage-1 read allowlist; refuse money-write and undeclared; dark plane refuses whole select.

## Paths

```
docs/ops/slices/L3-2026-08-05-navigator-tool-select.md
services/svc-agents/src/navigator/tool-select.ts
services/svc-agents/src/navigator/tool-select.test.ts
```

## Board-Delta

L3 Class N: navigator tool_select pure planner (allowlist ∩ candidates).
