import { describe, expect, it } from 'vitest';
import { readChannelSettings, readTemplates } from './config-model';

const setting = {
  channel: 'email',
  configured: false,
  requires: ['EMAIL_API_KEY'],
  enabled: null,
  adapter: null,
  version: 0,
  effective: 'unconfigured',
  notConnected: null,
};
const template = {
  key: 'login_code',
  fields: ['brand', 'code'],
  current: { version: 2, subject: 'Your code', body: 'Code {{code}}', authorId: 'u1', createdAt: '2026-10-17T02:00:00.000Z' },
};

describe('channel settings reader', () => {
  it('reads a channel with no credentials as unconfigured, keeping the names of what it needs', () => {
    expect(readChannelSettings([setting])).toEqual([setting]);
  });
  it('refuses a malformed row instead of returning a shorter list', () => {
    expect(readChannelSettings([setting, { ...setting, channel: 'fax' }])).toBeNull();
    expect(readChannelSettings([{ ...setting, effective: 'maybe' }])).toBeNull();
    expect(readChannelSettings([{ ...setting, version: -1 }])).toBeNull();
    expect(readChannelSettings({})).toBeNull();
  });
});

describe('template reader', () => {
  it('reads a saved version and a template with none', () => {
    const rows = readTemplates([template, { key: 'kyc_decision', fields: ['decision'], current: null }]);
    expect(rows?.[0]?.current?.version).toBe(2);
    expect(rows?.[1]?.current).toBeNull();
  });
  it('refuses a malformed version or date', () => {
    expect(readTemplates([{ ...template, current: { ...template.current, version: 0 } }])).toBeNull();
    expect(readTemplates([{ ...template, current: { ...template.current, createdAt: 'soon' } }])).toBeNull();
    expect(readTemplates([{ ...template, fields: 'code' }])).toBeNull();
  });
});
