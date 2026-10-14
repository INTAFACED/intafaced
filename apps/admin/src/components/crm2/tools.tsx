'use client';
/**
 * The tools behind the quiet "Tools" menu: Follow-ups, Duplicates, Sources and campaigns, Exports. They are the existing views,
 * unchanged, shown inside the console's own stylesheet (the `adm-workspace` wrapper) rather than rebuilt.
 */
import { useState } from 'react';
import { CrmCampaigns, CrmDuplicates, CrmExports, CrmTasks } from '../crm-workflows';
import type { FounderOwner } from '../founder-names';
import { stageLabel } from './format';
import type { ToolView } from './url-state';

const AUDIENCES = ['investor', 'trader', 'merchant', 'academy', 'partner'] as const;
const STAGES = ['new', 'qualified', 'diligence', 'terms', 'invited', 'onboarding', 'closed'] as const;
const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Exports keeps its Audience, Stage and Owner filters (they used to sit in the list's filter row). */
function ExportsTool({ csrf, owners }: { csrf: string; owners: FounderOwner[] }) {
  const [audience, setAudience] = useState('');
  const [stage, setStage] = useState('');
  const [owner, setOwner] = useState('');
  return (
    <>
      <form className="adm-filters is-open" onSubmit={(event) => event.preventDefault()}>
        <label className="adm-filter-field">
          Audience
          <select aria-label="Audience" value={audience} onChange={(event) => setAudience(event.target.value)}>
            <option value="">All</option>
            {AUDIENCES.map((value) => (
              <option key={value} value={value}>
                {cap(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-filter-field">
          Stage
          <select aria-label="Stage" value={stage} onChange={(event) => setStage(event.target.value)}>
            <option value="">All</option>
            {STAGES.map((value) => (
              <option key={value} value={value}>
                {stageLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="adm-filter-field">
          Owner
          <select aria-label="Owner" value={owner} onChange={(event) => setOwner(event.target.value)}>
            <option value="">Both</option>
            {owners.map((value) => (
              <option key={value.userId} value={value.userId}>
                {value.displayName}
              </option>
            ))}
          </select>
        </label>
      </form>
      <CrmExports
        csrf={csrf}
        owners={owners}
        filters={{ ...(audience ? { audience } : {}), ...(stage ? { stage } : {}), ...(owner ? { ownerUserId: owner } : {}) }}
      />
    </>
  );
}

export function ToolPanel({
  tool,
  csrf,
  owners,
  version,
  onOpenEnquiry,
  onChanged,
}: {
  tool: ToolView;
  csrf: string;
  owners: FounderOwner[];
  version: number;
  onOpenEnquiry: (id: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  return (
    <div className="adm-workspace" id="crm-tool">
      {tool === 'followups' ? (
        <CrmTasks initialOverdue={false} version={version} filtersActive={false} owners={owners} onOpen={onOpenEnquiry} />
      ) : null}
      {tool === 'campaigns' ? <CrmCampaigns csrf={csrf} owners={owners} version={version} /> : null}
      {tool === 'duplicates' ? (
        <CrmDuplicates csrf={csrf} owners={owners} version={version} onChanged={async () => void (await onChanged())} />
      ) : null}
      {tool === 'exports' ? <ExportsTool csrf={csrf} owners={owners} /> : null}
    </div>
  );
}
