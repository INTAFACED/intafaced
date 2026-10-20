import { describe, expect, it } from 'vitest';
import { moduleForPage } from '@/lib/modules';
import { parseRoomQuery, refusalWords, roomHref } from './model';

describe('case room query', () => {
  it('builds the filter svc-ops understands from the address', () => {
    const q = parseRoomQuery({
      inbox: 'inb_1',
      level: 'red',
      unassigned: '1',
      tags: 'a, b',
      from: '2026-10-01',
      to: '2026-10-20',
      limit: '25',
      group: '1',
    });
    expect(q.inboxId).toBe('inb_1');
    expect(q.limit).toBe(25);
    expect(q.group).toBe(true);
    expect(q.filter).toEqual({
      reviewLevels: ['red'],
      unassignedOnly: true,
      tags: ['a', 'b'],
      createdFrom: '2026-10-01T00:00:00.000Z',
      createdTo: '2026-10-20T23:59:59.999Z',
    });
  });

  it('never invents a page size: no limit stays null, and a bad one does too', () => {
    expect(parseRoomQuery({}).limit).toBeNull();
    expect(parseRoomQuery({ limit: '0' }).limit).toBeNull();
    expect(parseRoomQuery({ limit: '9999' }).limit).toBeNull();
    expect(parseRoomQuery({ limit: 'abc' }).limit).toBeNull();
  });

  it('ignores an unknown review level and malformed dates', () => {
    expect(parseRoomQuery({ level: 'purple', from: 'yesterday' }).filter).toEqual({});
  });

  it('keeps the page size in links and drops empty parts', () => {
    expect(roomHref({ inbox: 'a', limit: '10', case: null })).toBe('/compliance/cases?inbox=a&limit=10');
    expect(roomHref({})).toBe('/compliance/cases');
  });

  it('has words for every typed refusal and none for an unknown code', () => {
    for (const code of [
      'compliance.inbox_forbidden',
      'compliance.case_not_found',
      'compliance.queue_entity_unknown',
      'compliance.cases_list_limit_unset',
      'compliance.queue_name_taken',
    ]) {
      expect(refusalWords(code)).toBeTruthy();
    }
    expect(refusalWords('something.else')).toBeNull();
    expect(refusalWords(null)).toBeNull();
  });

  it('sits under the jurisdiction module gate', () => {
    expect(moduleForPage('/compliance/cases')).toBe('jurisdiction');
    expect(moduleForPage('/compliance/cases/case-1')).toBe('jurisdiction');
  });
});
