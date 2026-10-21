import { labelVerdict, networkLabel, type LabelEntry, type ProtocolOpsLabelsOutput } from '@intafaced/contracts';
import type { NetworkEntry } from '@intafaced/contracts';

/**
 * Every place THIS service serves a network label or an audited flag. The customer and admin copy catalogues are scanned
 * by the admin app (it can read them and this service cannot); the verdict here covers what the service itself says, and
 * the admin PR merges the three surfaces through `labelVerdict`.
 */
export function serviceLabelEntries(input: {
  networks: readonly NetworkEntry[];
  configuredChainId: number;
  audit: { id: string; audited: boolean };
}): LabelEntry[] {
  const entries: LabelEntry[] = input.networks.map((network) => ({
    surface: 'service',
    where: `protocol.networks.list:${network.chainId}`,
    label: `${network.name ?? ''} ${network.kind}`.trim(),
    audited: false,
  }));
  const configured = networkLabel(input.configuredChainId);
  entries.push({
    surface: 'service',
    where: `protocol.chainStatus:${input.configuredChainId}`,
    label: `${configured.name}. ${configured.note}`,
    audited: false,
  });
  entries.push({
    surface: 'service',
    where: `protocol.auditStatus:${input.audit.id}`,
    label: 'internal audit package',
    audited: input.audit.audited,
  });
  return entries;
}

export function labelsOutput(entries: LabelEntry[], now: Date): ProtocolOpsLabelsOutput {
  return { asOf: now.toISOString(), entries, verdict: labelVerdict(entries) };
}
