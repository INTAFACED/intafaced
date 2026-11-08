import {
  ADDRESS_REPUTATIONS,
  type AddressReportKind,
  type AddressReputation,
  type ProtocolAddressLabel,
  type ProtocolAddressReportReceipt,
  type ProtocolAddressRisk,
} from '@intafaced/contracts/protocol-address-risk';
import { getAddress as toChecksum, isAddress, type Address } from 'viem';

/**
 * Address risk (D-developer-compliance-01): the published labels about an address, the open-report count and whether a
 * sanctions list is loaded, and the scam report a signed-in person files. A label is a record, not a verdict. The public
 * read never carries who reported or what they wrote. With no AML list source connected the sanctioned set is empty and
 * the read says `not_loaded`, never that the address is clean.
 */
export const REPORT_DUPLICATE = 'protocol.reports.duplicate' as const;
export const REPORT_ADDRESS_INVALID = 'protocol.reports.address_invalid' as const;
export const REPORT_EVIDENCE_INVALID = 'protocol.reports.evidence_invalid' as const;
type RefusalCode = typeof REPORT_DUPLICATE | typeof REPORT_ADDRESS_INVALID | typeof REPORT_EVIDENCE_INVALID;

export class AddressReportRefusedError extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'AddressReportRefusedError';
  }
}

export type LabelRecord = Omit<ProtocolAddressLabel, 'setAt'> & { setAt: Date };
export type ReportRecord = {
  id: string;
  idempotencyKey: string;
  chainId: number;
  address: Address;
  reporterId: string;
  kind: AddressReportKind;
  evidenceUrl: string | null;
  note: string | null;
  createdAt: Date;
};
export type NewReport = Omit<ReportRecord, 'id' | 'createdAt'>;

export interface AddressRiskStore {
  labels(chainId: number, address: Address): Promise<LabelRecord[]>;
  openReportCount(chainId: number, address: Address): Promise<number>;
  /** Writes the report and its queue row in one transaction; `duplicate` when the key already has an open report. */
  insertReport(report: NewReport): Promise<{ kind: 'created'; report: ReportRecord } | { kind: 'duplicate' }>;
}

/** The business idempotency key: one open report per reporter, chain and address. */
export const reportKey = (reporterId: string, chainId: number, address: Address) =>
  `report:${reporterId}:${chainId}:${address.toLowerCase()}`;

export function highestReputation(labels: readonly Pick<LabelRecord, 'reputation'>[]): AddressReputation {
  let top = 0;
  for (const label of labels) top = Math.max(top, ADDRESS_REPUTATIONS.indexOf(label.reputation));
  return ADDRESS_REPUTATIONS[top]!;
}

export async function readAddressRisk(
  store: AddressRiskStore,
  input: { chainId: number; address: string; screeningLoaded: boolean },
): Promise<ProtocolAddressRisk> {
  const address = toChecksum(input.address);
  const [labels, openReports] = await Promise.all([store.labels(input.chainId, address), store.openReportCount(input.chainId, address)]);
  return {
    chainId: input.chainId,
    address,
    reputation: highestReputation(labels),
    labels: labels.map((label) => ({ ...label, setAt: label.setAt.toISOString() })),
    openReports,
    screening: input.screeningLoaded ? { status: 'loaded', code: null } : { status: 'not_loaded', code: 'vendor.aml' },
  };
}

function cleanEvidence(url: string | undefined): string | null {
  const text = url?.trim();
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new AddressReportRefusedError(REPORT_EVIDENCE_INVALID, 'The evidence must be an http or https link.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new AddressReportRefusedError(REPORT_EVIDENCE_INVALID, 'The evidence must be an http or https link.');
  return parsed.toString();
}

export async function submitReport(
  store: AddressRiskStore,
  input: { chainId: number; reporterId: string; address: string; kind: AddressReportKind; evidenceUrl?: string; note?: string },
): Promise<ProtocolAddressReportReceipt> {
  if (!isAddress(input.address, { strict: false }))
    throw new AddressReportRefusedError(REPORT_ADDRESS_INVALID, 'That is not an address on this network.');
  const address = toChecksum(input.address);
  const note = input.note?.trim() || null;
  const outcome = await store.insertReport({
    idempotencyKey: reportKey(input.reporterId, input.chainId, address),
    chainId: input.chainId,
    address,
    reporterId: input.reporterId,
    kind: input.kind,
    evidenceUrl: cleanEvidence(input.evidenceUrl),
    note,
  });
  if (outcome.kind === 'duplicate')
    throw new AddressReportRefusedError(REPORT_DUPLICATE, 'You already reported this address; your report is still open.');
  const { report } = outcome;
  return { id: report.id, chainId: report.chainId, address: report.address, kind: report.kind, createdAt: report.createdAt.toISOString() };
}

/** In-memory store for tests. Same rules as the Postgres one. */
export class MemoryAddressRiskStore implements AddressRiskStore {
  readonly labelRows: (LabelRecord & { chainId: number; address: Address })[] = [];
  readonly reports: (ReportRecord & { status: 'open' | 'published' | 'dismissed' })[] = [];
  private seq = 0;
  addLabel(chainId: number, address: Address, label: LabelRecord) {
    this.labelRows.push({ ...label, chainId, address: toChecksum(address) });
  }
  async labels(chainId: number, address: Address): Promise<LabelRecord[]> {
    return this.labelRows
      .filter((row) => row.chainId === chainId && row.address === toChecksum(address))
      .map(({ chainId: _chain, address: _address, ...label }) => label);
  }
  async openReportCount(chainId: number, address: Address) {
    return this.reports.filter((r) => r.chainId === chainId && r.address === toChecksum(address) && r.status === 'open').length;
  }
  async insertReport(report: NewReport) {
    if (this.reports.some((r) => r.idempotencyKey === report.idempotencyKey && r.status === 'open')) return { kind: 'duplicate' as const };
    const row = {
      ...report,
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`,
      createdAt: new Date(),
      status: 'open' as const,
    };
    this.reports.push(row);
    return { kind: 'created' as const, report: row };
  }
}
