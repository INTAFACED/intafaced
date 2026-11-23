import { describe, expect, it } from 'vitest';
import * as capture from './capture.js';
import * as capturePolicy from './capture-policy.js';
import * as entry from './index.js';
import * as batch from './ingest-capture-lake-batch.js';
import * as persistenceSink from './persistence-sink.js';
import * as quantHonestyMount from './quant-honesty-mount.js';
import * as quantHonestyPolicy from './quant-honesty-policy.js';
import * as quantSurfaceRefuse from './quant-surface-refuse.js';
import * as quantSurfaceRender from './quant-surface-render-consumer.js';
import * as retentionMaintenance from './retention-maintenance.js';
import * as retentionPolicy from './retention-policy.js';
import * as retentionPurge from './retention-purge.js';

/** Each symbol the package entry must mount, and the module that implements it. */
const MOUNTED: ReadonlyArray<readonly [keyof typeof entry, Record<string, unknown>]> = [
  ['ingestCaptureLakeBatch', batch],
  ['describeIngestCaptureLakeBatch', batch],
  ['flushCaptureLogToPersistenceSink', persistenceSink],
  ['retentionPersistenceGate', retentionPolicy],
  ['purgeExpiredLakeTicks', retentionPurge],
  ['runConnectDataLakeRetentionMaintenance', retentionMaintenance],
  ['gateBacktestRender', quantHonestyPolicy],
  ['describeQuantHonestyPolicy', quantHonestyPolicy],
  ['gateQuantSurfaceRender', quantHonestyMount],
  ['describeQuantHonestyMount', quantHonestyMount],
  ['refuseQuantSurfaceRender', quantSurfaceRefuse],
  ['describeQuantSurfaceRefuse', quantSurfaceRefuse],
  ['EDGE_QUANT_SURFACE_RENDER_DOOR', quantSurfaceRefuse],
  ['EDGE_QUANT_COMPOSITE_HONESTY_DOOR', quantSurfaceRefuse],
  ['evaluateQuantSurfaceRender', quantSurfaceRender],
  ['classifyFillAmendment', capture],
  ['isFillAmendment', capture],
  ['wouldInventFill', capturePolicy],
];

const DOORS = new Set<string>(['EDGE_QUANT_SURFACE_RENDER_DOOR', 'EDGE_QUANT_COMPOSITE_HONESTY_DOOR']);

describe('connect-data-lake package exports mount', () => {
  it.each(MOUNTED)('the entry mounts %s from its implementing module', (name, source) => {
    const value: unknown = entry[name];
    expect(value, `${name} is missing from the package entry`).toBeDefined();
    expect(value, `${name} on the entry is not the implementing module's export`).toBe(source[name]);
    if (DOORS.has(name)) expect(value).toMatch(/^\/quant\/honesty\//);
    else expect(typeof value, `${name} must be callable`).toBe('function');
  });

  it('the describe functions it mounts answer when called', () => {
    expect(entry.describeQuantSurfaceRefuse()).toEqual(expect.any(Object));
    expect(entry.describeQuantHonestyMount()).toEqual(expect.any(Object));
    expect(entry.describeQuantHonestyPolicy()).toEqual(expect.any(Object));
    expect(entry.describeIngestCaptureLakeBatch({})).toEqual(expect.any(Object));
  });

  it('the edge doors it mounts are the quant honesty paths', () => {
    expect(entry.EDGE_QUANT_SURFACE_RENDER_DOOR).toBe('/quant/honesty/assess-surface-render');
    expect(entry.EDGE_QUANT_COMPOSITE_HONESTY_DOOR).toBe('/quant/honesty/assess-composite');
  });
});
