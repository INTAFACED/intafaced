import { describe, expect, it } from 'vitest';
import {
  executionComposeBlock,
  executionEmsStoreComposeWired,
  executionLetterBpsScheduleComposeWired,
  executionVenueOperatorCredComposeWired,
  matchExecutionComposeBlock,
} from './execution-compose-wiring.js';
import { executionSorComposeGapsClosed } from './mount-vs-tracker.js';

describe('execution.sor fleet compose wiring', () => {
  it('svc-execution block declares durable EMS journal path + volume', () => {
    expect(executionEmsStoreComposeWired()).toBe(true);
    expect(executionComposeBlock()).toMatch(/execution-ems-journal:\/data\/execution/);
  });

  it('svc-execution passes venue.aggregation operator credential env through', () => {
    expect(executionVenueOperatorCredComposeWired()).toBe(true);
  });

  it('svc-execution passes letter→bps owner schedule env through', () => {
    expect(executionLetterBpsScheduleComposeWired()).toBe(true);
  });

  it('closes durable_ems_store, live_venue_cred_operator_wiring, and letter_to_bps_owner_schedule compose gaps', () => {
    expect(executionSorComposeGapsClosed()).toBe(true);
  });

  it('returns the svc-execution block when that service is last', () => {
    const block = matchExecutionComposeBlock(
      ['services:', '  svc-tax:', '    image: tax', '  svc-execution:', '    image: execution', '    volume: journal', ''].join('\n'),
    );
    expect(block).toBe(['  svc-execution:', '    image: execution', '    volume: journal', ''].join('\n'));
  });

  it('stops the svc-execution block before the next service header', () => {
    const block = matchExecutionComposeBlock(['  svc-execution:', '    image: execution', '  svc-tax:', '    image: tax', ''].join('\n'));
    expect(block).toBe(['  svc-execution:', '    image: execution', ''].join('\n'));
  });

  it('keeps a line that starts with Z when svc-execution is the last service', () => {
    const block = matchExecutionComposeBlock(
      ['  svc-execution:', '    image: execution', 'Zed stays in the block', '    volume: journal', ''].join('\n'),
    );
    expect(block).toBe(['  svc-execution:', '    image: execution', 'Zed stays in the block', '    volume: journal', ''].join('\n'));
  });
});
