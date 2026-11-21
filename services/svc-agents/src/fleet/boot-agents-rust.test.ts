import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerProductAgentsAtBoot } from './boot-register.js';
import { registerCatalogueOnlyAgents } from './catalogue-only.js';
import { parseGuardrail, serialiseGuardrail } from './guardrails.js';
import { registerCoachAgent } from '../coach/coach-run.js';

/**
 * The Rust port's boot upserts the rows `crates/svc-agents/src/boot_agents.json` lists. They are this boot's rows,
 * captured from its own three calls; a factory, the Coach or a catalogue-only agent that changes here makes that file
 * stale, and this test fails until `scripts/record-door.mjs` writes it again.
 */
describe('the Rust port boot upserts the rows this boot upserts', () => {
  it('crates/svc-agents/src/boot_agents.json is the boot of index.ts, in its order', async () => {
    const rows: unknown[] = [];
    const recording = {
      async registerAgent(input: unknown, options: { enabled?: boolean } = {}) {
        const guardrail = parseGuardrail(input);
        rows.push({
          agentId: guardrail.agentId,
          version: guardrail.version,
          guardrail: serialiseGuardrail(guardrail),
          enabled: options.enabled ?? true,
        });
        return guardrail;
      },
    };
    await registerProductAgentsAtBoot(recording);
    await registerCoachAgent(recording);
    await registerCatalogueOnlyAgents(recording);

    const file = new URL('../../../../crates/svc-agents/src/boot_agents.json', import.meta.url);
    const recorded: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(
      recorded,
      'crates/svc-agents/src/boot_agents.json is stale: run `TZ=UTC node --import tsx crates/svc-agents/scripts/record-door.mjs` from the repository root',
    ).toEqual(rows);
  });
});
