import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { roleNames, typeRoles } from '../contracts.js';
import {
  Gate,
  ActionKey,
  Button,
  Change,
  Checkbox,
  Dock,
  Field,
  Figure,
  LegalSlot,
  Logo,
  Radio,
  Rail,
  RefusalBox,
  RiskMoment,
  Select,
  Surface,
  TextArea,
  type DoorLink,
} from './index.js';
import * as B2 from './b2-basics.js';
import { Table, gridKey } from './b2-table.js';
import { StateBlock } from './b2-values.js';
import { ChartMark } from './b2-controls.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const css = readFileSync(join(here, 'components.css'), 'utf8');
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('the component sheet reads only lit roles', () => {
  it('holds no raw colour of its own', () => {
    const hex = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(hex).toEqual([]);
    expect(css.match(/\b(rgba?|hsla?|oklch|lab)\(/gi) ?? []).toEqual([]);
    expect(css.match(/[:,\s](black|white)\b(?!-)/gi) ?? []).toEqual([]);
  });

  it('every --lit-* it reads is a declared role or type role', () => {
    const declared = new Set<string>(roleNames.map((r) => `--lit-${r}`));
    for (const t of Object.keys(typeRoles)) for (const k of ['size', 'line', 'weight', 'tracking']) declared.add(`--lit-type-${t}-${k}`);
    const used = new Set([...css.matchAll(/var\((--lit-[a-z0-9-]+)/g)].map((m) => m[1]!));
    // local knobs a component sets for itself (light angle, corner), never colours
    const local = new Set(['--lit-light-angle', '--lit-corner-x', '--lit-corner-y', '--lit-tag-c']);
    for (const u of used) if (!local.has(u)) expect(declared.has(u), u).toBe(true);
  });

  it('uses logical sides only, so right-to-left needs nothing', () => {
    expect(css.match(/\b(margin|padding|border|inset)-(left|right)\b/g) ?? []).toEqual([]);
    expect(css.match(/(^|[;{\s])(left|right)\s*:/gm) ?? []).toEqual([]);
  });

  it('uses no backdrop blur except through the nav and sheet layers', () => {
    const blocks = css.split('}').filter((b) => /backdrop-filter/.test(b));
    for (const b of blocks) expect(b, b).toMatch(/data-layer='(nav|sheet)'/);
  });
});

describe('components', () => {
  it('a tab never shrinks below its words, so longer copy stays inside it (#9930; the row is one line and scrolls, #10303)', () => {
    const templates = readFileSync(join(here, '../templates/templates.css'), 'utf8');
    expect(templates).toMatch(/\n\.lt-tabs \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/);
    expect(templates).toMatch(/\n\.lt-tab \{[^}]*flex: none;[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/);
  });

  it('Surface is solid on the content layer by default, and glass only on nav or sheet', () => {
    expect(html(<Surface />)).toContain('data-layer="content"');
    expect(html(<Surface />)).toContain('data-material="solid"');
    const nav = html(<Surface layer="nav" />);
    expect(nav).toContain('data-layer="nav"');
    expect(nav).not.toContain('data-material');
  });

  it('Button defaults to secondary so a primary is always a choice', () => {
    expect(html(<Button>Go</Button>)).toContain('data-tone="secondary"');
    expect(html(<Button tone="primary">Go</Button>)).toContain('data-tone="primary"');
    // test locators read the kit's data-slot and data-variant, like the flat Button
    expect(html(<Button tone="primary">Go</Button>)).toContain('data-slot="button" data-variant="primary"');
  });

  it('ActionKey keeps its label as text and hides the icon from assistive tech', () => {
    const out = html(<ActionKey icon={<svg />} label="Send" />);
    expect(out).toContain('>Send<');
    expect(out).toContain('aria-hidden="true"');
  });

  it('Figure splits the minor part, labels TEST, and reads as one value', () => {
    const gbp = [
      { type: 'currency', value: '£' },
      { type: 'integer', value: '12' },
      { type: 'group', value: ',' },
      { type: 'integer', value: '480' },
      { type: 'decimal', value: '.' },
      { type: 'fraction', value: '36' },
    ];
    const out = html(<Figure parts={gbp} test size="hero" />);
    expect(out).toContain('<span class="lit-figure__unit">£</span>');
    expect(out).toContain('<span class="lit-figure__minor">36</span>');
    expect(out).toContain('>TEST<');
    expect(out).toContain('<span class="lit-sr" dir="ltr" data-ltr="">£12,480.36</span>');
  });

  it('Figure keeps the locale order of the parts (unit after the number)', () => {
    const eur = [
      { type: 'integer', value: '12' },
      { type: 'decimal', value: ',' },
      { type: 'fraction', value: '5' },
      { type: 'literal', value: '\u00a0' },
      { type: 'currency', value: '€' },
    ];
    const out = html(<Figure parts={eur} />);
    expect(out).toContain('<span class="lit-sr" dir="ltr" data-ltr="">12,5\u00a0€</span>');
    expect(out.indexOf('lit-figure__unit')).toBeGreaterThan(out.indexOf('>12<'));
  });

  it('Change says the direction in words, not only colour', () => {
    expect(html(<Change text="£84.10" dir="up" spoken="en hausse" />)).toContain('<span class="lit-sr">en hausse </span>');
    // The arrow is drawn, pointing the way it moved; a flat change has none.
    expect(html(<Change text="£6.40" dir="down" spoken="down" />)).toContain(
      '<span class="lt-arrow lt-arrow-down" aria-hidden="true" data-arrow="down"></span>',
    );
    expect(html(<Change text="£84.10" dir="up" spoken="up" />)).toContain(
      '<span class="lt-arrow lt-arrow-up" aria-hidden="true" data-arrow="up"></span>',
    );
    expect(html(<Change text="£0.00" dir="flat" spoken="no change" />)).not.toContain('lt-arrow');
    expect(html(<Change text="£6.40" dir="down" spoken="down" />)).not.toMatch(/[▲▼]/);
  });

  it('RefusalBox names the blocker, keeps the code small, and draws hold and pause apart', () => {
    const hold = html(
      <RefusalBox
        refusal={{ variant: 'account-hold', title: 'Your account is on hold', body: 'Checks are running.', reference: 'identity.hold' }}
      />,
    );
    expect(hold).toContain('data-variant="account-hold"');
    expect(hold).toContain('identity.hold');
    expect(html(<RefusalBox refusal={{ variant: 'platform-pause', title: 'Payments are paused', body: 'For everyone.' }} />)).toContain(
      'data-variant="platform-pause"',
    );
  });

  it('Dock shows all five doors in order and refuses a missing one', () => {
    const links: DoorLink[] = [
      { door: 'more', label: 'More', href: '/more', icon: null },
      { door: 'home', label: 'Home', href: '/home', icon: null },
      { door: 'money', label: 'Money', href: '/money', icon: null },
      { door: 'trade', label: 'Trade', href: '/trade', icon: null },
      { door: 'pay', label: 'Pay', href: '/pay', icon: null },
    ];
    const out = html(<Dock links={links} current="home" label="Main" />);
    expect(html(<Rail links={links} current="pay" label="Main" />)).toMatch(/^<nav aria-label="Main">/);
    const order = [...out.matchAll(/href="\/([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['home', 'money', 'trade', 'pay', 'more']);
    expect(out).toContain('aria-current="page"');
    expect(() => html(<Dock links={links.slice(1)} current="home" label="Main" />)).toThrow(/more door/);
  });

  it('Logo mark has an accessible name when it stands alone', () => {
    expect(html(<Logo variant="mark" />)).toContain('aria-label="INTAFACED"');
  });

  it('Field keeps a caller description next to its own hint', () => {
    const out = html(<Field label="Amount" hint="Max 500" aria-describedby="terms" id="a" />);
    expect(out).toContain('aria-describedby="terms a-hint"');
  });

  it('Field draws a mark before and a control after its text inside one box, and is unchanged without them', () => {
    const out = html(<Field label="To" id="to" before="@" after={<button type="button">Paste</button>} error="No one has that handle" />);
    expect(out).toBe(
      '<div class="lit-field-control"><label for="to">To</label><div data-part="box"><span data-part="before" aria-hidden="true">@</span><input id="to" aria-invalid="true" aria-describedby="to-error"/><button type="button">Paste</button></div><span id="to-error" data-part="error" role="alert">No one has that handle</span></div>',
    );
    expect(html(<Field label="To" id="to" />)).toBe('<div class="lit-field-control"><label for="to">To</label><input id="to"/></div>');
  });

  it('Select is a labelled native select whose change hands back the value', () => {
    const out = html(<Select label="Role" value="b" options={['a', { value: 'b', label: 'Bee' }]} hint="Pick one" />);
    // Named by its words alone, not by its words and the chosen option (J-developer-08 #3 finds "Status" exactly).
    const named = out.match(/^<label class="lt-field"><span id="([^"]+)">Role<\/span><select aria-labelledby="([^"]+)">/);
    expect(named?.[1]).toBeTruthy();
    expect(named?.[2]).toBe(named?.[1]);
    expect(out).toContain('<option value="a">a</option><option value="b" selected="">Bee</option>');
    expect(out).toContain('<small>Pick one</small>');
  });

  it('Radio is a native radio button named by its words, one of a shared name', () => {
    const out = html(
      <Radio name="scope" value="all" checked readOnly>
        All components
      </Radio>,
    );
    expect(out).toBe(
      '<label class="lt-field"><input readOnly="" type="radio" name="scope" checked="" value="all"/><span>All components</span></label>',
    );
  });

  it('Checkbox is a native tick box named by its words or its own label', () => {
    const out = html(
      <Checkbox checked readOnly aria-label="Allow Runner">
        Allowed
      </Checkbox>,
    );
    expect(out).toMatch(/^<label class="lt-field"><input [^>]*type="checkbox"[^>]*\/><span>Allowed<\/span><\/label>$/);
    expect(out).toContain('checked=""');
    expect(out).toContain('aria-label="Allow Runner"');
  });

  it('TextArea is a labelled native text box whose hint describes it and whose change hands back the text', () => {
    const out = html(<TextArea id="why" label="Why" value="TEST" readOnly maxLength={500} hint="Up to 500 characters" aria-invalid />);
    expect(out).toMatch(
      /^<label class="lt-field"><span>Why<\/span><textarea [^>]*>TEST<\/textarea><small id="why-hint">Up to 500 characters<\/small><\/label>$/,
    );
    expect(out).toContain('aria-describedby="why-hint"');
    expect(out).toContain('maxLength="500"');
    expect(out).toContain('aria-invalid="true"');
    expect(html(<TextArea label="Note" name="note" />)).not.toContain('aria-describedby');
  });

  it('LegalSlot holds no copy of its own, and an unset text shows a refusal in words, never the id', () => {
    const base = { type: 'risk-band', moment: 'first-buy', jurisdiction: 'uk', textId: 'risk.band', label: 'Risk warning' } as const;
    const missing = html(<LegalSlot {...base} text={null} missing="This warning isn't available yet." />);
    expect(missing).toContain('data-missing="true"');
    expect(missing).toContain('data-text-id="risk.band"');
    expect(missing.replace(/data-text-id="[^"]*"/, '')).not.toContain('risk.band');
    const set = html(
      <LegalSlot {...base} text="Warning." missing="-" learnMore={{ label: 'Take 2 mins to learn more', onOpen: () => {} }} />,
    );
    expect(set).not.toContain('data-missing');
    expect(set).toContain('aria-label="Risk warning"');
    expect(set).toContain('<button type="button" class="lit-legal__more">');
    const rtl = html(<LegalSlot {...base} text="Warning." missing="-" bold lang="en" dir="ltr" />);
    expect(rtl).toContain('data-bold="true"');
    expect(rtl).toMatch(/lang="en" dir="ltr" role="region"/);
    expect(rtl).toContain('<span data-part="text">Warning.</span>');
    expect(html(<LegalSlot {...base} text="" missing="Not set yet." />)).toContain('Not set yet.');
  });

  it('RiskMoment gives both choices the same weight', () => {
    const out = html(
      <RiskMoment title="Before you buy" proceed={{ label: 'Continue', onChoose: () => {} }} leave={{ label: 'Leave', onChoose: () => {} }}>
        Body
      </RiskMoment>,
    );
    const tones = [...out.matchAll(/data-tone="([a-z]+)"/g)].map((m) => m[1]);
    expect(tones).toEqual(['secondary', 'secondary']);
    expect(out).toContain('role="dialog"');
  });

  it('Gate puts its card in the flow above the room, which stays visible and inert, never a skeleton', () => {
    const out = html(
      <Gate reason="not-verified" title="Verify to send" body="It takes about two minutes.">
        <div>room</div>
      </Gate>,
    );
    expect(out).toContain('data-gate="not-verified"');
    expect(out).toMatch(/class="lit-gate__room" inert=""><div>room<\/div>/);
    expect(out.indexOf('lit-gate__card')).toBeLessThan(out.indexOf('lit-gate__room'));
    expect(out).not.toContain('lit-gate__veil');
    expect(out).toContain('data-material="solid"');
    expect(out).not.toContain('skeleton');
  });

  it('money figures and changes read left to right on a right-to-left page', () => {
    const fig = html(
      <Figure
        parts={[
          { type: 'currency', value: '£' },
          { type: 'integer', value: '45' },
          { type: 'fraction', value: '.53' },
        ]}
        test
      />,
    );
    expect(fig.match(/dir="ltr" data-ltr=""/g)).toHaveLength(2);
    expect(fig).not.toMatch(/lit-figure__marks"[^>]*dir=/);
    const change = html(<Change text="+£45.53 (+0.37%)" dir="up" spoken="up" />);
    expect(change).toContain('<span dir="ltr" data-ltr="">+£45.53 (+0.37%)</span>');
  });
});

describe('b2 controls the desk rooms use', () => {
  it('Select is a combobox button naming its list, showing the chosen label, and opens a listbox of options', () => {
    const out = html(
      <B2.Select
        label="Market"
        value="eth"
        options={[
          { value: 'btc', label: 'BTC/USDT' },
          { value: 'eth', label: 'ETH/USDT' },
        ]}
        onChange={() => undefined}
      />,
    );
    expect(out).toMatch(/<button[^>]*role="combobox"/);
    expect(out).toContain('aria-label="Market"');
    expect(out).toContain('aria-haspopup="listbox"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('ETH/USDT');
    // Closed, the list is not drawn; a value not among the options is shown as itself.
    expect(out).not.toContain('role="listbox"');
    expect(html(<B2.Select label="Schedule" value="a-9" options={[]} onChange={() => undefined} />)).toContain('a-9');
    expect(html(<B2.Select label="Leader" value="" placeholder="Choose a leader" options={[]} onChange={() => undefined} />)).toContain(
      'Choose a leader',
    );
  });

  it('Select keys: closed, arrows, Enter and Space open; open, they move, pick and close, held at the ends', () => {
    expect(['ArrowDown', 'ArrowUp', 'Enter', ' '].map((k) => B2.selectKey(k, false))).toEqual(['open', 'open', 'open', 'open']);
    expect(B2.selectKey('a', false)).toBeNull();
    expect(['Enter', ' ', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].map((k) => B2.selectKey(k, true))).toEqual([
      'pick',
      'pick',
      'close',
      'close',
      'next',
      'previous',
      'first',
      'last',
    ]);
    expect(B2.nextOptionIndex(2, 'next', 3)).toBe(2);
    expect(B2.nextOptionIndex(0, 'previous', 3)).toBe(0);
    expect(B2.nextOptionIndex(1, 'last', 3)).toBe(2);
    expect(B2.nextOptionIndex(1, 'first', 3)).toBe(0);
  });

  it('Sheet is a dialog with its own Close; as an alertdialog its own buttons answer it, so it draws no Close', () => {
    const dialog = html(
      <B2.Sheet open={false} title="Details" onClose={() => undefined}>
        x
      </B2.Sheet>,
    );
    expect(dialog).not.toContain('role="alertdialog"');
    expect(dialog).toContain('>Close</button>');
    const alert = html(
      <B2.Sheet open={false} role="alertdialog" title="Cancel this order?" onClose={() => undefined}>
        <button type="button">Go back</button>
      </B2.Sheet>,
    );
    expect(alert).toContain('role="alertdialog"');
    expect(alert).toContain('aria-label="Cancel this order?"');
    expect(alert).not.toContain('>Close</button>');
    const form = html(
      <B2.Sheet open={false} closeButton={false} title="Close part of this position" onClose={() => undefined}>
        <button type="submit">Close</button>
      </B2.Sheet>,
    );
    expect(form).not.toContain('role="alertdialog"');
    expect(form.match(/>Close<\/button>/g)).toHaveLength(1);
  });

  it('Tabs draw links with aria-current, or in-page tabs: a tablist of tabs, the shown one selected and the one Tab stop', () => {
    const links = html(<B2.Tabs label="Rooms" current="/a" items={[{ label: 'A', href: '/a' }]} />);
    expect(links).toContain('aria-current="page"');
    expect(links).not.toContain('role="tab"');
    const tabs = html(
      <B2.Tabs
        id="exec"
        label="Sections"
        value="b"
        onChange={() => undefined}
        items={[
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ]}
      />,
    );
    expect(tabs).toMatch(/role="tablist" aria-label="Sections"/);
    expect(tabs).toMatch(/id="exec-tab-b" aria-controls="exec-panel-b" aria-selected="true" tabindex="0"/);
    expect(tabs).toMatch(/id="exec-tab-a" aria-controls="exec-panel-a" aria-selected="false" tabindex="-1"/);
    expect(B2.nextTabIndex(1, 'ArrowRight', 2)).toBe(0);
    expect(B2.nextTabIndex(0, 'ArrowLeft', 2)).toBe(1);
    expect(B2.nextTabIndex(1, 'Home', 2)).toBe(0);
    expect(B2.nextTabIndex(0, 'End', 2)).toBe(1);
    expect(B2.nextTabIndex(0, 'x', 2)).toBeNull();
    expect(
      html(
        <B2.TabPanel id="exec" value="a" current="b">
          hidden
        </B2.TabPanel>,
      ),
    ).toBe('');
    expect(
      html(
        <B2.TabPanel id="exec" value="b" current="b">
          shown
        </B2.TabPanel>,
      ),
    ).toMatch(/role="tabpanel" id="exec-panel-b" aria-labelledby="exec-tab-b"/);
  });

  it('a tab panel is a Tab stop only while it holds nothing a keyboard can reach', () => {
    const asked: string[] = [];
    const panel = (found: boolean) => ({
      querySelector: (selector: string) => {
        asked.push(selector);
        return found ? ({} as Element) : null;
      },
    });
    expect(B2.panelIsTabStop(panel(false))).toBe(true);
    expect(B2.panelIsTabStop(panel(true))).toBe(false);
    for (const reach of ['a[href]', 'button', 'input', 'select', 'textarea', '[tabindex]:not([tabindex="-1"])'])
      expect(asked[0]).toContain(reach);
    // Before it can look (server render), the panel starts as a stop, so Tab never skips a panel of plain text.
    expect(
      html(
        <B2.TabPanel id="exec" value="b" current="b">
          shown
        </B2.TabPanel>,
      ),
    ).toContain('tabindex="0"');
  });

  it('a tab keeps its whole name and a Segmented label sits centred on its fill', () => {
    const tab = /\.lt-tab \{([^}]*)\}/.exec(readFileSync(join(here, '../templates/templates.css'), 'utf8'))?.[1] ?? '';
    expect(tab).toMatch(/flex: none;/);
    const seg = /\.lit-segmented button \{([^}]*)\}/.exec(readFileSync(join(here, 'components.css'), 'utf8'))?.[1] ?? '';
    expect(seg).toMatch(/text-align: center;/);
  });

  it('Table with onSelect is a grid of pickable rows; with no rows it shows its empty line', () => {
    const cols = [{ key: 'id', label: 'Id', cell: (r: { id: string }) => r.id }];
    const grid = html(
      <Table
        caption="Schedules"
        columns={cols}
        rows={[{ id: 'a' }, { id: 'b' }]}
        rowKey={(r) => r.id}
        selected="b"
        onSelect={() => undefined}
      />,
    );
    expect(grid).toContain('role="grid"');
    expect(grid).toMatch(/aria-selected="false" tabindex="-1"/);
    expect(grid).toMatch(/aria-selected="true" tabindex="0"/);
    expect(html(<Table caption="Plain" columns={cols} rows={[{ id: 'a' }]} rowKey={(r) => r.id} />)).not.toContain('role="grid"');
    expect(html(<Table caption="None" columns={cols} rows={[]} rowKey={(r) => r.id} empty="No open orders" />)).toContain(
      '<td colSpan="1">No open orders</td>',
    );
    expect([
      gridKey('Enter', 0, 3),
      gridKey('ArrowDown', 2, 3),
      gridKey('ArrowUp', 0, 3),
      gridKey('End', 0, 3),
      gridKey('x', 0, 3),
    ]).toEqual(['pick', 2, 0, 2, null]);
  });

  it('DecimalInput keeps a decimal string, never a number, and asks for the decimal keyboard', () => {
    const out = html(<B2.DecimalInput aria-label="Total size (BTC)" value="0.001" precision={8} onValueChange={() => undefined} />);
    expect(out).toContain('value="0.001"');
    expect(out).toContain('inputMode="decimal"');
    expect(out).toContain('type="text"');
  });

  it('DecimalInput given a label draws its own field: named by the label alone, the unit beside it, hint and error describing it', () => {
    const out = html(
      <B2.DecimalInput
        id="px"
        label="Limit price"
        unit="USDT"
        value="500"
        onValueChange={() => undefined}
        precision={2}
        hint="Step 0.5"
        error="Too far"
      />,
    );
    expect(out).toContain('<label for="px">Limit price</label>');
    expect(out).toContain('<span class="lt-field-unit">USDT</span>');
    expect(out).toContain('aria-describedby="px-hint px-error"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('<small id="px-hint">Step 0.5</small>');
    expect(out).toContain('<small id="px-error" role="alert">Too far</small>');
    // Without a label it stays the bare box a room puts in its own field.
    expect(html(<B2.DecimalInput aria-label="Size" value="1" onValueChange={() => undefined} precision={2} />)).toMatch(/^<input /);
  });

  it('Sheet draws its buttons in a footer at its end and its Close can say more than its word', () => {
    const out = html(
      <B2.Sheet
        open={false}
        title="Add margin"
        closeLabel="Close dialog"
        footer={<button type="button">Add</button>}
        onClose={() => undefined}
      >
        <p>Body</p>
      </B2.Sheet>,
    );
    expect(out).toContain('aria-label="Close dialog"');
    expect(out).toContain('>Close</button>');
    expect(out).toMatch(/<\/div><footer class="lt-sheet-foot"><button type="button">Add<\/button><\/footer><\/dialog>$/);
    const bare = html(
      <B2.Sheet open={false} title="Details" onClose={() => undefined}>
        x
      </B2.Sheet>,
    );
    expect(bare).not.toContain('<footer');
    expect(bare).not.toContain('aria-label="Close');
  });

  it('Sheet with a description draws it under the title and is described by it', () => {
    const out = html(
      <B2.Sheet open={false} role="alertdialog" title="Place this order?" description="Buy 1 at 500" onClose={() => undefined}>
        <button type="button">Go back</button>
      </B2.Sheet>,
    );
    const id = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`<p id="${id}" class="lt-description">Buy 1 at 500</p>`);
    expect(
      html(
        <B2.Sheet open={false} title="Details" onClose={() => undefined}>
          x
        </B2.Sheet>,
      ),
    ).not.toContain('aria-describedby');
  });

  it('Table sorts by a header button with aria-sort, and marks its empty row', () => {
    const columns = [
      { key: 'name', label: 'Name', cell: (r: { name: string }) => r.name, sortType: 'text' as const },
      { key: 'size', label: 'Size', cell: () => '1' },
    ];
    const out = html(
      <Table
        caption="Rows"
        columns={columns}
        rows={[{ name: 'a' }]}
        rowKey={(r) => r.name}
        sort={{ columnId: 'name', direction: 'asc' }}
        onSort={() => undefined}
      />,
    );
    expect(out).toMatch(/<th scope="col" data-align="start" aria-sort="ascending"><button type="button" class="lt-sort">Name/);
    expect(out).toContain('<th scope="col" data-align="start">Size</th>');
    expect(html(<Table caption="Rows" columns={columns} rows={[]} rowKey={(r) => r.name} empty="Nothing here" />)).toContain(
      '<tr data-empty=""><td colSpan="2">Nothing here</td></tr>',
    );
  });

  it('KeyValue marks each row, so a reader finds a value by its label', () => {
    expect(html(<B2.KeyValue rows={[{ label: 'Start price', value: '0.99' }]} />)).toContain('<div data-slot="key-value-row">');
    expect(html(<B2.TestTag />)).toBe('<span class="lt-test">TEST</span>');
    expect(html(<B2.Checkbox label="Random slice sizes" checked onChange={() => undefined} />)).toBe(
      '<label class="lt-field"><input type="checkbox" checked=""/><span>Random slice sizes</span></label>',
    );
  });

  it('FreshnessChip says the freshness in a word, its time when asked, and why when it is unknown', () => {
    const at = Date.UTC(2026, 10, 22, 10, 0, 0);
    const live = html(<B2.FreshnessChip asOf={at} now={at + 500} staleAfterMs={10_000} showAsOf />);
    expect(live).toContain('data-freshness="live"');
    expect(live).toContain('>Live<');
    expect(live).toContain('as of');
    const stale = html(<B2.FreshnessChip asOf={at} now={at + 20_000} staleAfterMs={10_000} />);
    expect(stale).toContain('>Stale<');
    const unknown = html(<B2.FreshnessChip asOf={null} staleAfterMs={10_000} reason="Could not be read" />);
    expect(unknown).toContain('>Unknown<');
    expect(unknown).toContain('<span class="lt-sr">Could not be read</span>');
    expect(html(<B2.FreshnessChip asOf={at} now={at + 500} staleAfterMs={10_000} refused />)).toContain('>Refused<');
  });

  it('FreshnessChip takes a fixed kind and the room\'s own words for each kind and for "as of"', () => {
    const at = Date.UTC(2026, 10, 22, 10, 0, 0);
    // A lifecycle state drawn in the chip's shapes: the kind is the room's, not the read's age.
    const closing = html(<B2.FreshnessChip asOf={null} staleAfterMs={0} kind="stale" labels={{ stale: 'Closing' }} reason="Liquidation" />);
    expect(closing).toContain('data-freshness="stale"');
    expect(closing).toContain('<span data-part="word">Closing</span>');
    expect(closing).toContain('<span class="lt-sr">Liquidation</span>');
    const asOf = html(
      <B2.FreshnessChip
        asOf={at}
        now={at + 500}
        staleAfterMs={10_000}
        showAsOf
        asOfLabel="read at"
        timeZone="UTC"
        labels={{ live: 'Positions live' }}
      />,
    );
    expect(asOf).toContain('>Positions live<');
    expect(asOf).toContain(' · read at <time');
    // Without them the chip reads as it always has.
    expect(html(<B2.FreshnessChip asOf={at} now={at + 500} staleAfterMs={10_000} showAsOf />)).toContain(' · as of <time');
  });
});

describe('b2 parts carry what the spot desk needs, so it uses them and no second kit', () => {
  it('Select takes its name from the page, a size, help, and options listed but refused', () => {
    const out = html(
      <B2.Select
        labelledBy="tif-label"
        describedBy="tif-note"
        title="How long it rests"
        size="sm"
        className="lt-grow"
        value="GTC"
        options={[
          { value: 'GTC', label: 'Good till cancelled', data: { 'data-tif': 'GTC' } },
          { value: 'FOK', label: 'Fill or kill · not offered by this venue', disabled: true, title: 'Not offered' },
        ]}
      />,
    );
    expect(out).toContain('<div class="lt-select lt-grow">');
    expect(out).toContain('aria-labelledby="tif-label"');
    expect(out).toContain('aria-describedby="tif-note"');
    expect(out).toContain('title="How long it rests"');
    expect(out).toContain('data-size="sm"');
    expect(out).not.toContain('aria-label=');
    expect(out).toContain('>Good till cancelled<');
  });

  it('in-page Tabs may go unnamed and take a layout class; a TabPanel carries a class and a test id', () => {
    const tabs = html(
      <B2.Tabs id="bt" items={[{ label: 'Order book', value: 'book' }]} value="book" onChange={() => undefined} className="lt-grow" />,
    );
    expect(tabs).toContain('<div class="lt-tabs lt-grow" role="tablist">');
    // Soft tabs (a board's own) add their class beside the row's; the tabs inside are the same tabs.
    const soft = html(<B2.Tabs id="sb" soft items={[{ label: 'Popular', value: 'popular' }]} value="popular" onChange={() => undefined} />);
    expect(soft).toContain('<div class="lt-tabs lt-tabs-soft" role="tablist">');
    expect(soft).toContain('aria-selected="true"');
    const panel = html(
      <B2.TabPanel id="bt" value="book" current="book" className="lt-stack" testId="dk-bottom-body">
        <p>Rows</p>
      </B2.TabPanel>,
    );
    expect(panel).toContain('class="lt-tab-panel lt-stack"');
    expect(panel).toContain('data-testid="dk-bottom-body"');
    expect(
      html(
        <B2.TabPanel id="bt" value="book" current="tape">
          <p>Rows</p>
        </B2.TabPanel>,
      ),
    ).toBe('');
  });

  it('Sheet carries a test id, and its Close button’s spoken name says in which language it is', () => {
    const out = html(
      <B2.Sheet open={false} title="Account" closeLabel="Dialog schließen" closeLang="de" testId="venue-account" onClose={() => undefined}>
        <p>Body</p>
      </B2.Sheet>,
    );
    expect(out).toContain('data-testid="venue-account"');
    expect(out).toContain(
      '<button type="button" class="lt-button lt-button-secondary" aria-label="Dialog schließen" lang="de">Close</button>',
    );
  });

  it('Checkbox may keep its name for assistive tech only (a row’s pick box)', () => {
    expect(html(<B2.Checkbox label={<span className="lt-sr">Select order a-1</span>} checked={false} onChange={() => undefined} />)).toBe(
      '<label class="lt-field"><input type="checkbox"/><span><span class="lt-sr">Select order a-1</span></span></label>',
    );
  });

  it('DecimalInput with a tick draws its steppers, and its Max and BBO keys when asked', () => {
    const out = html(
      <B2.DecimalInput
        label="Price"
        unit="USDT"
        value="10"
        tick="0.01"
        precision={2}
        stepLabels={{ up: 'Raise price', down: 'Lower price' }}
        onMax={() => undefined}
        onBbo={() => undefined}
        onValueChange={() => undefined}
      />,
    );
    expect(out).toContain('<span class="lt-field-steps">');
    expect(out).toContain('aria-label="Raise price"');
    expect(out).toContain('aria-label="Lower price"');
    expect(out).toContain('class="lt-field-key">BBO</button>');
    expect(out).toContain('class="lt-field-key">Max</button>');
    const read = html(<B2.DecimalInput label="Price" value="10" tick="0.01" precision={2} readOnly onValueChange={() => undefined} />);
    expect(read).not.toContain('lt-field-steps');
    expect(html(<B2.DecimalInput label="Size" value="1" precision={2} onValueChange={() => undefined} />)).not.toContain('lt-field-steps');
  });

  it('Table marks its rows and cells, draws dense rows and scrolls in a labelled region', () => {
    const out = html(
      <Table
        caption="Balances"
        dense
        scroll
        columns={[
          { key: 'free', label: 'Free', align: 'end', cell: (r: { asset: string }) => r.asset, cellMarks: () => ({ 'data-cell': 'free' }) },
        ]}
        rows={[{ asset: 'BTC' }]}
        rowKey={(r) => r.asset}
        rowMarks={(r) => ({ 'data-asset': r.asset })}
      />,
    );
    expect(out).toMatch(
      /^<div class="lt-table-scroll" tabindex="0" role="region" aria-label="Balances"><table class="lt-table lt-table-dense"/,
    );
    expect(out).toContain('<tr data-asset="BTC" data-row="">');
    expect(out).toContain('<td data-cell="free" data-label="Free" data-align="end">');
  });
});

describe('kit parts that take copy keep the language of the words they are given', () => {
  // A German page whose room copy has no German yet for these keys: the words fall back to English, and say so.
  const onGermanPage = (el: React.ReactElement) => html(<div lang="de">{el}</div>);

  it('a Sheet title that fell back is read in its own language, and names the sheet from that heading', () => {
    const out = onGermanPage(
      <B2.Sheet open={false} title="Close this position?" titleLang="en" onClose={() => undefined}>
        <p>Body</p>
      </B2.Sheet>,
    );
    const id = out.match(/<h2 class="lt-sheet-title" id="([^"]+)" lang="en">Close this position\?<\/h2>/)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`aria-labelledby="${id}"`);
    expect(out).not.toContain('aria-label="Close this position?"');
  });

  it('a Sheet whose title is in the page language keeps its name as before, with no lang of its own', () => {
    const out = onGermanPage(
      <B2.Sheet open={false} title="Position schließen?" onClose={() => undefined}>
        <p>Body</p>
      </B2.Sheet>,
    );
    expect(out).toContain('aria-label="Position schließen?"');
    expect(out).toContain('<h2 class="lt-sheet-title">Position schließen?</h2>');
  });

  it('a failure note says its title and its Try again words in their own languages', () => {
    const out = onGermanPage(
      <StateBlock
        kind="error"
        title="Couldn’t load trades"
        titleLang="en"
        onRetry={() => undefined}
        retryLabel="Try again"
        retryLang="en"
      />,
    );
    expect(out).toContain('<p class="lt-state-title" lang="en">Couldn’t load trades</p>');
    expect(out).toMatch(/<button type="button" class="lit-button"[^>]* lang="en">Try again<\/button>/);
  });

  it('a failure note with only the kit’s own words claims no language for them', () => {
    const out = onGermanPage(<StateBlock kind="error" thing="trades" titleLang="en" onRetry={() => undefined} retryLang="en" />);
    expect(out).not.toMatch(/lt-state-title" lang=/);
    expect(out).toContain('Couldn&#x27;t load trades.');
    expect(out).not.toContain(' lang="en">Try again');
  });

  it('an empty or refused note, and its action, keep their languages', () => {
    expect(onGermanPage(<StateBlock kind="empty" title="No trades" titleLang="en" />)).toContain(
      '<h3 class="lt-state-title" lang="en">No trades</h3>',
    );
    const refused = onGermanPage(
      <StateBlock
        kind="refused"
        title="Market closed"
        titleLang="en"
        body="Opens at 09:00."
        action={{ label: 'Sign in', href: '/sign-in', lang: 'en' }}
      />,
    );
    expect(refused).toContain('<p class="lt-state-title" lang="en">Market closed</p>');
    expect(refused).toMatch(/<a class="lit-button"[^>]* href="\/sign-in" lang="en">Sign in<\/a>/);
  });
});

describe('a price alert handle on a drawn chart', () => {
  it('is a button mark at its price, by the price axis, drawn by the sheet', () => {
    const out = html(
      <ChartMark as="button" kind="alert" y={42} aria-label="Move alert">
        Above 100
      </ChartMark>,
    );
    expect(out).toBe(
      '<button type="button" aria-label="Move alert" data-mark="alert" class="lt-chart-mark" style="inset-block-start:42px">Above 100</button>',
    );
    expect(css).toMatch(/\.lt-chart-mark\[data-mark='alert'\] \{[^}]*inset-inline-end: 4\.5rem;[^}]*pointer-events: auto;/);
  });

  it('a line a finger drags is at least a 24px target (WCAG 2.5.8), however close the next line sits', () => {
    expect(css).toMatch(/\.lt-chart-mark\[data-mark='line'\] \{[^}]*min-block-size: 24px;[^}]*pointer-events: auto;/);
  });
});

describe('a tag', () => {
  it("is the pick's soft pill: sentence case in the page's type, quiet grey unless toned, never lime by default", () => {
    const at = css.indexOf('.lit-tag {');
    const body = css.slice(at, css.indexOf('}', at));
    expect(body).not.toContain('text-transform');
    expect(body).not.toContain('font-family');
    expect(body).not.toContain('clip-path');
    expect(body).not.toContain('--lit-accent');
    expect(body).toContain('border-radius: var(--lit-radius-key);');
  });
});

describe('a disabled main action', () => {
  it('keeps its place with a lime rim and no fill, after the rule that darkens every other disabled tone', () => {
    const all = css.indexOf('.lit-button[data-tone]:disabled {');
    const at = css.indexOf(".lit-button[data-tone='primary']:disabled {");
    expect(all).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(all);
    const body = css.slice(at, css.indexOf('}', at));
    expect(body).toContain('background: none;');
    expect(body).toContain('box-shadow: inset 0 0 0 1px var(--lit-accent-fill);');
  });
});
