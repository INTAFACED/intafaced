import { describe, expect, it } from 'vitest';
import { CHART_STYLES } from './chart-style';
import { FEATURESETS, describeFeatureset, styleOnDesk } from './featureset';

describe('chart options per desk', () => {
  it('turns every part on for the workbench and only candles and line on for the spot desk', () => {
    expect(describeFeatureset(FEATURESETS.workbench)).toBe(`styles=${CHART_STYLES.join(',')} studies=on drawings=on templates=on`);
    expect(describeFeatureset(FEATURESETS['spot-desk'])).toBe('styles=candles,line studies=off drawings=off templates=off');
  });

  it("gives a desk a template's style only when the desk draws it", () => {
    expect(styleOnDesk(FEATURESETS.workbench, 'heikin-ashi', 'candles')).toBe('heikin-ashi');
    expect(styleOnDesk(FEATURESETS['spot-desk'], 'heikin-ashi', 'line')).toBe('line');
    expect(styleOnDesk(FEATURESETS['spot-desk'], 'candles', 'line')).toBe('candles');
  });
});
