import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseDetectors } from '@/lib/trade-ops/surveillance-model';
import { SurveillanceCases } from './surveillance-cases';

const off = (reason: string) => ({ enabled: false, gap: 'detector_gap', reason, threshold: null });
const html = (props: Partial<Parameters<typeof SurveillanceCases>[0]>) =>
  renderToStaticMarkup(<SurveillanceCases cases={[]} unreadable={null} noCases {...props} />);

describe('Surveillance with the detectors off', () => {
  it('names each off detector with its gap code and does not read as "no abuse"', () => {
    const out = html({ detectors: parseDetectors({ spoofing: off('spoofing'), layering: off('layering') }) });
    expect(out).toContain('Spoofing detector is off (detector_gap): it cannot open a case');
    expect(out).toContain('Layering detector is off (detector_gap): it cannot open a case');
    expect(out).toContain('so this is not a sign that there is no spoofing and layering');
    expect(out).not.toContain('The matching engine reports no open cases.');
  });
  it('says the detector state is unknown when the block was missing', () => {
    const out = html({ detectors: null });
    expect(out).toContain('Detector state unknown');
    expect(out).toContain('is unknown, so this is not a sign');
  });
  it('shows no detector notice when the cases could not be read, and the plain sentence when both are on', () => {
    expect(html({ noCases: false, detectors: undefined })).not.toContain('Detector');
    const on = { enabled: true, gap: null };
    const out = html({ detectors: { spoofing: on, layering: on } });
    expect(out).not.toContain('Detector');
    expect(out).toContain('The matching engine reports no open cases.');
  });
});
