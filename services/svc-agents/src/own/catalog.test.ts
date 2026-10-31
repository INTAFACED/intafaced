import { describe, expect, it } from 'vitest';
import {
  OWN_TEMPLATE_IDS,
  OWN_TEMPLATES,
  OWN_TOOLS,
  OwnAgentRefusal,
  parseOwnTemplates,
  protectionFindings,
  validateDraft,
} from './catalog.js';
import { FLEET_HARD_MONEY_WRITE_TOOLS } from '../fleet/guardrails.js';
import { ownGuardrail } from './routes.js';

const draft = (over: Partial<Parameters<typeof validateDraft>[0]> = {}) =>
  validateDraft({ name: 'TEST helper', instructions: '', tools: [], perSessionCap: null, ...over });
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof OwnAgentRefusal) return err.code;
    throw err;
  }
  return null;
};

describe('own agent templates offered (AGENTS_OWN_TEMPLATES)', () => {
  it('unset or blank offers every built-in template; a list offers those and blank; blank alone offers only blank', () => {
    expect(parseOwnTemplates(undefined)).toEqual(OWN_TEMPLATE_IDS);
    expect(parseOwnTemplates(' , ')).toEqual(OWN_TEMPLATE_IDS);
    expect(parseOwnTemplates('service-starter')).toEqual(['service-starter', 'blank']);
    expect(parseOwnTemplates(' blank ')).toEqual(['blank']);
  });

  it('an unknown template id stops the boot, naming it', () => {
    expect(() => parseOwnTemplates('blank,growth-pack')).toThrow('AGENTS_OWN_TEMPLATES names an unknown template: growth-pack');
  });
});

describe('declared tool shapes (AG-tools-01)', () => {
  it('every attachable read tool but pay.metrics.read declares an input, an output and its refusals', () => {
    for (const tool of OWN_TOOLS.filter((entry) => !entry.movesMoney && entry.name !== 'pay.metrics.read')) {
      expect(Object.keys(tool.shape?.input ?? {}).length, tool.name).toBeGreaterThan(0);
      expect(Object.keys(tool.shape?.output ?? {}).length, tool.name).toBeGreaterThan(0);
      expect(tool.refusals.length, tool.name).toBeGreaterThan(0);
    }
    // identity.account.read never answers a balance.
    expect(JSON.stringify(OWN_TOOLS.find((entry) => entry.name === 'identity.account.read')?.shape)).not.toMatch(/balance/i);
  });

  it('a tool with no declared shape is refused with agents.tool_shape_missing, naming it', () => {
    expect(OWN_TOOLS.find((entry) => entry.name === 'pay.metrics.read')?.shape).toBeNull();
    expect(() => draft({ tools: ['support.kb.search', 'pay.metrics.read'] })).toThrow(
      expect.objectContaining({ code: 'agents.tool_shape_missing', params: { tool: 'pay.metrics.read' } }),
    );
  });

  it('a session never grants a tool with no declared shape, even one a draft saved before shapes were declared', () => {
    const guardrail = ownGuardrail({
      id: '11111111-1111-4111-8111-111111111111',
      template: 'blank',
      name: 'TEST older draft',
      instructions: '',
      tools: ['support.kb.search', 'pay.metrics.read'],
      perSessionCap: '1',
      version: 1,
      state: 'draft',
      findings: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(guardrail.tools.map((tool) => tool.name)).toEqual(['support.kb.search']);
    expect(guardrail.limits.allowedModules).toEqual(['support']);
  });

  it('a money tool is still refused as a money tool first', () => {
    expect(refusal(() => draft({ tools: ['ledger.transfer'] }))).toBe('agents.own.money_tool');
  });
});

describe('own agent drafts', () => {
  it('starts the service starter with read tools only, all from the addable catalogue', () => {
    for (const tool of OWN_TEMPLATES['service-starter'].tools) {
      expect(OWN_TOOLS.find((entry) => entry.name === tool)).toMatchObject({ movesMoney: false });
    }
    expect(OWN_TEMPLATES.blank.tools).toEqual([]);
  });

  it('offers every money tool only to refuse it, with its reason', () => {
    for (const tool of ['ledger.transfer', ...FLEET_HARD_MONEY_WRITE_TOOLS]) {
      expect(OWN_TOOLS.find((entry) => entry.name === tool)?.movesMoney, tool).toBe(true);
      expect(
        refusal(() => draft({ tools: ['support.kb.search', tool] })),
        tool,
      ).toBe('agents.own.money_tool');
    }
  });

  it('refuses a tool it does not know, a reserved name and an oversize field', () => {
    expect(refusal(() => draft({ tools: ['support.kb.searchx'] }))).toBe('agents.own.tool_unknown');
    expect(refusal(() => draft({ name: 'sessions' }))).toBe('agents.own.reserved_name');
    expect(refusal(() => draft({ name: ' Navigator ' }))).toBe('agents.own.reserved_name');
    expect(refusal(() => draft({ name: 'x'.repeat(65) }))).toBe('agents.own.name_too_long');
    expect(refusal(() => draft({ instructions: 'x'.repeat(4001) }))).toBe('agents.own.instructions_too_long');
  });

  it('keeps a blank cap blank and refuses one that is not a positive amount', () => {
    expect(draft({ perSessionCap: '  ' }).perSessionCap).toBeNull();
    expect(draft({ perSessionCap: undefined }).perSessionCap).toBeNull();
    expect(draft({ perSessionCap: '1.50' }).perSessionCap).toBe('1.5');
    for (const cap of ['0', '-1', 'one', '1e3', '0.0000000000000000001'])
      expect(
        refusal(() => draft({ perSessionCap: cap })),
        cap,
      ).toBe('agents.own.cap_invalid');
  });

  it('stores each tool once and trims the name', () => {
    expect(draft({ name: '  TEST helper ', tools: ['trade.quote', 'trade.quote'] })).toMatchObject({
      name: 'TEST helper',
      tools: ['trade.quote'],
    });
  });

  it('blocks publishing while the cap or the name is unset', () => {
    expect(protectionFindings({ name: '', perSessionCap: null })).toEqual([
      { code: 'agents.spend.cap_unset', blocksPublishing: true },
      { code: 'agents.own.name_unset', blocksPublishing: true },
    ]);
    expect(protectionFindings({ name: 'TEST helper', perSessionCap: '1' })).toEqual([]);
  });
});
