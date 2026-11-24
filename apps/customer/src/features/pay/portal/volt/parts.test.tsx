import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EntityList } from './parts';

describe('EntityList', () => {
  it('names each cell by its worded column, so a phone that stacks the row still says what each value is', () => {
    const html = renderToStaticMarkup(
      <EntityList
        label="API keys"
        rows={[{ id: 'k1', used: '2 Nov' }]}
        rowKey={(r) => r.id}
        columns={[
          { header: 'Last used', cell: (r) => r.used },
          { header: <span className="lt-sr">Actions</span>, cell: () => 'Revoke' },
        ]}
      />,
    );
    expect(html).toContain('<td data-label="Last used">2 Nov</td>');
    expect(html).toContain('<td>Revoke</td>');
  });
});
