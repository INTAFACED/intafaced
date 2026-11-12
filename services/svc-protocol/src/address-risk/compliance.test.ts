import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { approveLabel, askLabel, MemoryComplianceStore, readQueue } from './compliance.js';
import { MemoryAddressRiskStore, readAddressRisk, submitReport } from './risk.js';

const CHAIN_ID = 84532;
const SUSPECT = getAddress('0x00000000000000000000000000000000000ba5e0');

async function setup() {
  const risk = new MemoryAddressRiskStore();
  const store = new MemoryComplianceStore(risk);
  const input = { chainId: CHAIN_ID, reporterId: 'reporter', address: SUSPECT, kind: 'phishing' as const, note: 'TEST phishing report' };
  await submitReport(risk, input);
  await expect(submitReport(risk, input)).rejects.toMatchObject({ code: 'protocol.reports.duplicate' });
  const report = (await readQueue(store, CHAIN_ID, new Date())).reports[0]!;
  return { risk, store, report };
}

describe('compliance queue', () => {
  it('shows each report with its reporter and the refused duplicates; another chain sees none', async () => {
    const { store, report } = await setup();
    expect(report).toMatchObject({ address: SUSPECT, reporterId: 'reporter', duplicatesRefused: 1, status: 'open' });
    expect((await readQueue(store, 1, new Date())).reports).toEqual([]);
  });

  it('a label waits for a second person and then is public with its reason', async () => {
    const { risk, store, report } = await setup();
    const review = await askLabel(store, { chainId: CHAIN_ID, reportId: report.id, kind: 'phishing', reason: ' TEST ', requesterId: 'a' });
    expect(review.reason).toBe('TEST');
    expect((await readAddressRisk(risk, { chainId: CHAIN_ID, address: SUSPECT, screeningLoaded: false })).labels).toEqual([]);
    await expect(approveLabel(store, { chainId: CHAIN_ID, reviewId: review.id, approverId: 'a' })).rejects.toMatchObject({
      code: 'protocol.compliance.same_reviewer',
    });
    const done = await approveLabel(store, { chainId: CHAIN_ID, reviewId: review.id, approverId: 'b' });
    expect(done).toMatchObject({ status: 'published', approverId: 'b' });
    expect(await approveLabel(store, { chainId: CHAIN_ID, reviewId: review.id, approverId: 'c' })).toEqual(done);
    const card = await readAddressRisk(risk, { chainId: CHAIN_ID, address: SUSPECT, screeningLoaded: false });
    expect(card).toMatchObject({ reputation: 'UNSAFE', openReports: 0, labels: [{ kind: 'phishing', reason: 'TEST', version: 1 }] });
  });

  it('refuses an unknown report, a second pending review and an unknown review', async () => {
    const { store, report } = await setup();
    const ask = { chainId: CHAIN_ID, reportId: report.id, kind: 'phishing' as const, reason: 'TEST', requesterId: 'a' };
    await expect(askLabel(store, { ...ask, reportId: '00000000-0000-4000-8000-0000000000ff' })).rejects.toMatchObject({
      code: 'protocol.compliance.report_unknown',
    });
    await askLabel(store, ask);
    await expect(askLabel(store, ask)).rejects.toMatchObject({ code: 'protocol.compliance.review_pending' });
    await expect(
      approveLabel(store, { chainId: CHAIN_ID, reviewId: '00000000-0000-4000-9000-0000000000ff', approverId: 'b' }),
    ).rejects.toMatchObject({ code: 'protocol.compliance.review_unknown' });
  });
});
