import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Checkbox, SectionTabs, TabList } from './b2-basics.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('SectionTabs', () => {
  it('draws one button per section in a named group, the open one pressed and no other', () => {
    const out = html(
      <SectionTabs
        label="Wallet sections"
        items={[
          { value: 'send', label: 'Send' },
          { value: 'scan', label: 'Scan' },
        ]}
        value="scan"
        onChange={() => undefined}
      />,
    );
    expect(out).toContain('role="group" aria-label="Wallet sections"');
    expect(out).toContain('<button type="button" class="lt-tab" aria-pressed="false">Send</button>');
    expect(out).toContain('<button type="button" class="lt-tab" aria-pressed="true">Scan</button>');
  });
});

describe('TabList', () => {
  it('is a named tab list, the chosen tab selected and the only one in the Tab order, each naming its panel', () => {
    const out = html(
      <TabList
        label="Send or receive"
        items={[
          { value: 'send', label: 'Send' },
          { value: 'receive', label: 'Receive' },
        ]}
        value="receive"
        onChange={() => undefined}
        panelOf={(value) => `panel-${value}`}
      />,
    );
    expect(out).toContain('<div class="lt-tabs" role="tablist" aria-label="Send or receive">');
    expect(out).toContain(
      '<button type="button" role="tab" class="lt-tab" aria-selected="false" aria-controls="panel-send" tabindex="-1">Send</button>',
    );
    expect(out).toContain(
      '<button type="button" role="tab" class="lt-tab" aria-selected="true" aria-controls="panel-receive" tabindex="0">Receive</button>',
    );
  });
});

describe('Checkbox', () => {
  it('is a native checkbox inside its label, so its words name it, and takes the input attributes', () => {
    const out = html(<Checkbox label="I agree" checked readOnly name="agree" />);
    expect(out).toBe('<label class="lt-field"><input readOnly="" type="checkbox" name="agree" checked=""/><span>I agree</span></label>');
  });
});
