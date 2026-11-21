import { describe, expect, it } from 'vitest';
import { TRPCError } from '@intafaced/contracts';
import { AgentError } from './errors.js';
import { agentsRefusal } from './record-refusal.js';

describe('agentsRefusal: the one refusal reader the call-records codemod mounts svc-agents with', () => {
  it("names a domain refusal by its cause's code and sends the very error thrown, so the wire does not move", () => {
    const cause = new AgentError('operator text', 'agents.session_not_found', 'agents.error.engine_unavailable');
    const thrown = new TRPCError({ code: 'NOT_FOUND', message: cause.userMessageKey, cause });
    const read = agentsRefusal(thrown);
    expect(read?.code).toBe('agents.session_not_found');
    expect(read?.error).toBe(thrown);
  });

  it('names a door refused in place by the machine code it sends as its message', () => {
    const thrown = new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
    expect(agentsRefusal(thrown)).toEqual({ code: 'agents.capability_unavailable', error: thrown });
  });

  it('leaves anything else unnamed: a raw domain error, plain words, a non-error', () => {
    expect(agentsRefusal(new AgentError('x', 'agents.refused', 'agents.error.engine_unavailable'))).toBeUndefined();
    expect(agentsRefusal(new TRPCError({ code: 'FORBIDDEN', message: 'A signed-in user session is required' }))).toBeUndefined();
    expect(agentsRefusal('agents.refused')).toBeUndefined();
  });
});
