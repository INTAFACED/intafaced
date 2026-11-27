import { describe, expect, it } from 'vitest';
import { deskLayoutsValueSchema, EMPTY_DESK_LAYOUTS } from '@intafaced/contracts/desk-layouts-preferences';
import { changeSymbol, contextOf, createLinkGroups, joinGroup, leaveGroup, NO_LINKS, type LinkContext } from './link-groups';
import { autosave, saveAs } from './saved-layouts';
import { isDeskLayout, presetLayout, type WidgetId } from './workspace';

const BTC: LinkContext = { symbol: 'BTC/USDT', venue: 'test-venue', kind: 'spot' };
const ETH: LinkContext = { symbol: 'ETH/USDT', venue: 'test-venue', kind: 'spot' };
const SOL: LinkContext = { symbol: 'SOL', venue: 'test-venue', kind: 'perpetual' };
const NOW = new Date('2026-11-27T09:00:00.000Z');

/** markets, chart and book in red on BTC; trades alone in blue on SOL. */
const grouped = () =>
  joinGroup(
    joinGroup(joinGroup(joinGroup(NO_LINKS, 'markets', 'red', BTC), 'chart', 'red', ETH), 'book', 'red', ETH),
    'trades',
    'blue',
    SOL,
  );

describe('panel link groups', () => {
  it('a panel joining a group takes what the group carries; the first one in sets it', () => {
    const links = grouped();
    expect(links.members).toEqual({ markets: 'red', chart: 'red', book: 'red', trades: 'blue' });
    expect(contextOf(links, 'chart', ETH)).toEqual(BTC);
    expect(contextOf(links, 'trades', BTC)).toEqual(SOL);
  });

  it('a symbol change in one panel reaches every member of its group and none outside it', () => {
    const { links, reached } = changeSymbol(grouped(), 'markets', ETH);
    expect(reached).toEqual(['markets', 'chart', 'book']);
    for (const member of ['markets', 'chart', 'book'] as const) expect(contextOf(links, member, BTC)).toEqual(ETH);
    expect(contextOf(links, 'trades', BTC)).toEqual(SOL);
  });

  it('a panel in no group changes only itself', () => {
    const links = leaveGroup(grouped(), 'book');
    const { links: after, reached } = changeSymbol(links, 'book', SOL);
    expect(reached).toEqual(['book']);
    expect(after).toBe(links);
    expect(contextOf(after, 'book', SOL)).toEqual(SOL);
    expect(contextOf(after, 'chart', SOL)).toEqual(BTC);
  });

  it('the last panel to leave a group takes the group with it', () => {
    const links = leaveGroup(grouped(), 'trades');
    expect(links.members.trades).toBeUndefined();
    expect(links.groups.blue).toBeUndefined();
  });

  it('a panel moving to another group follows that group and no longer its old one', () => {
    const moved = joinGroup(grouped(), 'book', 'blue', ETH);
    expect(contextOf(moved, 'book', ETH)).toEqual(SOL);
    const { reached } = changeSymbol(moved, 'chart', ETH);
    expect(reached).toEqual(['markets', 'chart']);
  });

  it('the live store tells each listening member of the group, and no panel outside it', () => {
    const store = createLinkGroups(grouped());
    const heard: Array<[WidgetId, string]> = [];
    const stops = (['markets', 'chart', 'book', 'trades'] as const).map((panel) =>
      store.subscribe(panel, (context) => heard.push([panel, context.symbol])),
    );
    store.change('chart', ETH);
    expect(heard).toEqual([
      ['markets', 'ETH/USDT'],
      ['chart', 'ETH/USDT'],
      ['book', 'ETH/USDT'],
    ]);
    stops[0]!();
    heard.length = 0;
    store.change('book', BTC);
    expect(heard).toEqual([
      ['chart', 'BTC/USDT'],
      ['book', 'BTC/USDT'],
    ]);
    expect(store.links().groups.red).toEqual(BTC);
  });

  it('a saved layout keeps its groups through a save and a load', () => {
    const desk = { ...presetLayout('advanced'), links: grouped() };
    const saved = saveAs(EMPTY_DESK_LAYOUTS, { name: 'Linked', symbol: 'BTC/USDT', interval: '15m', desk }, NOW);
    const loaded = deskLayoutsValueSchema.parse(JSON.parse(JSON.stringify(saved)));
    const layout = loaded.layouts[0]!;
    expect(layout.desk.links).toEqual(grouped());
    expect(isDeskLayout(layout.desk)).toBe(true);
    const { links } = changeSymbol(layout.desk.links!, 'markets', ETH);
    const autosaved = deskLayoutsValueSchema.parse(
      JSON.parse(JSON.stringify(autosave(loaded, { ...presetLayout('advanced'), links }, NOW))),
    );
    expect(autosaved.layouts[0]?.desk.links?.groups.red).toEqual(ETH);
    expect(autosaved.layouts[0]?.desk.links?.groups.blue).toEqual(SOL);
  });

  it('a desk whose groups name a panel it does not show is not a layout', () => {
    expect(isDeskLayout({ ...presetLayout('classic'), links: grouped() })).toBe(false);
  });
});
