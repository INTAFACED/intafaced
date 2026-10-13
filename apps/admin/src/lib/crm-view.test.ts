import { describe, expect, it } from 'vitest';
import { listSummary, pagerVisible, toolsLabel, viewHeading, viewShowsTotals } from './crm-view';

describe('CRM views', () => {
  it('gives each tool view one title and one line under it, and Enquiries none', () => {
    expect(viewHeading('enquiries')).toEqual({ title: 'Enquiries', description: null });
    for (const view of ['tasks', 'campaigns', 'duplicates', 'exports']) {
      const heading = viewHeading(view);
      expect(heading.title).toBeTruthy();
      expect(heading.description).toBeTruthy();
    }
    expect(viewHeading('exports').description).toBe('Up to 200 enquiries per file, with original answers, consent and source.');
    expect(viewHeading('unknown').title).toBe('Enquiries');
  });
  it('shows the totals strip and Reports only where enquiries are', () => {
    expect(['enquiries', 'tasks'].every(viewShowsTotals)).toBe(true);
    expect(['campaigns', 'duplicates', 'exports'].some(viewShowsTotals)).toBe(false);
  });
  it('names the open tool in the Tools button', () => {
    expect(toolsLabel('enquiries')).toBe('Tools');
    expect(toolsLabel('tasks')).toBe('Tools');
    expect(toolsLabel('duplicates')).toBe('Tools · Duplicates');
    expect(toolsLabel('campaigns')).toBe('Tools · Sources and campaigns');
  });
  it('shows the "shown / overdue" line only while a search is active', () => {
    expect(listSummary({ searching: false, loading: false, shown: 7, overdue: 0 })).toBeNull();
    expect(listSummary({ searching: true, loading: false, shown: 3, overdue: 1 })).toBe('3 shown · 1 overdue');
    expect(listSummary({ searching: true, loading: true, shown: 3, overdue: 1 })).toBe('Searching…');
  });
  it('hides the pager when there is only one page', () => {
    expect(pagerVisible(false, false)).toBe(false);
    expect(pagerVisible(true, false)).toBe(true);
    expect(pagerVisible(false, true)).toBe(true);
  });
});
