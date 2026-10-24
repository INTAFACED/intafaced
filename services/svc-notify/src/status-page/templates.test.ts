import { describe, expect, it } from 'vitest';
import { IncidentTemplates, MemoryTemplateStore, TEMPLATES_MAX } from './templates.js';

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const at = new Date('2026-10-23T12:00:00.000Z');
const make = (components: readonly string[] = ['payments']) =>
  new IncidentTemplates(
    new MemoryTemplateStore(),
    async () => components,
    () => at,
  );
const outage = {
  id: 'payments-down',
  name: 'Payments down',
  group: 'TEST outages',
  title: 'TEST payments are failing',
  body: 'TEST we are looking',
  impact: 'major',
  components: ['payments'],
};

describe('incident templates', () => {
  it('nothing is seeded: the list is empty until a founder defines one', async () => {
    expect(await make().list()).toEqual([]);
  });

  it('defines one with who and when, and the same wording again is the stored row', async () => {
    const t = make();
    const first = await t.define(FOUNDER, outage);
    expect(first).toEqual({ ...outage, definedBy: FOUNDER, definedAt: at.toISOString() });
    expect(await t.define('someone-else', { ...outage, name: ' Payments down ' })).toEqual(first);
    expect(await t.list()).toEqual([first]);
  });

  it('refuses a component the page does not define, and components with no impact', async () => {
    await expect(make([]).define(FOUNDER, outage)).rejects.toMatchObject({ code: 'status.template_component_unknown' });
    await expect(make().define(FOUNDER, { ...outage, impact: null })).rejects.toMatchObject({ code: 'status.template_impact_unset' });
    await expect(make().define(FOUNDER, { ...outage, components: [], impact: null })).resolves.toMatchObject({ components: [] });
    await expect(make().define(FOUNDER, { ...outage, title: '  ' })).rejects.toMatchObject({ code: 'status.template_invalid' });
    await expect(make().define(FOUNDER, { ...outage, id: 'Bad id' })).rejects.toMatchObject({ code: 'status.template_invalid' });
  });

  it('retires one so the picker no longer offers it; an unknown id is not found', async () => {
    const t = make();
    await t.define(FOUNDER, outage);
    await t.retire(FOUNDER, 'payments-down');
    expect(await t.list()).toEqual([]);
    await expect(t.retire(FOUNDER, 'payments-down')).rejects.toMatchObject({ code: 'status.template_not_found' });
  });

  it('stops at the store cap', async () => {
    const t = make();
    for (let i = 0; i < TEMPLATES_MAX; i += 1) await t.define(FOUNDER, { ...outage, id: `t-${i}`, components: [], impact: null });
    await expect(t.define(FOUNDER, { ...outage, id: 'one-more' })).rejects.toMatchObject({ code: 'status.template_cap_reached' });
    // Replacing an existing one is not growth.
    await expect(t.define(FOUNDER, { ...outage, id: 't-0' })).resolves.toMatchObject({ id: 't-0', impact: 'major' });
  });
});
