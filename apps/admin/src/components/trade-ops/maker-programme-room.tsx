'use client';

import { useState } from 'react';
import { PageSection } from './kit';
import { Field, TwoPersonForm } from './two-person-form';
import {
  checkMember,
  checkTerms,
  MAKER_PROGRAMME_TERM_UNSET,
  MAKER_PROGRAMME_TIER_UNKNOWN,
  type MemberInput,
  type MemberStatus,
  type TermsInput,
  type TierInput,
} from '@/lib/trade-ops/maker-programme-model';
import type { ClawbackRow, MemberRow, TermsRow } from '@/lib/trade-ops/maker-programme-view';

const TABLE = 'w-full border-collapse text-sm [&_td]:py-1 [&_td]:pe-3 [&_th]:py-1 [&_th]:pe-3 [&_th]:text-start [&_td]:text-start';
const TIER_ROWS = 3;

function Terms({ terms }: { terms: TermsRow | null }) {
  if (!terms) {
    return (
      <div data-terms="" data-state="unset" className="flex flex-col gap-1 text-sm">
        <span>
          No terms written. <code className="if-num text-xs">{MAKER_PROGRAMME_TERM_UNSET}</code>
        </span>
        <span className="text-fg-2">
          Every term is blank: no member can be admitted and no period can settle until the terms are written.
        </span>
      </div>
    );
  }
  return (
    <div data-terms="" data-state="set" data-version={terms.version} className="flex flex-col gap-4">
      <p className="text-xs text-fg-2">
        v{terms.version} · written by {terms.operatorId} · approved by {terms.approverId} · {terms.writtenAt}
      </p>
      <table className={TABLE}>
        <caption className="text-start text-xs text-fg-2">Tiers, by objective criteria</caption>
        <thead>
          <tr>
            <th scope="col">Tier</th>
            <th scope="col">30-day maker volume</th>
            <th scope="col">Uptime share</th>
            <th scope="col">Spread at depth</th>
            <th scope="col">Rebate</th>
          </tr>
        </thead>
        <tbody>
          {terms.tiers.map((t) => (
            <tr key={t.name} data-tier={t.name}>
              <td data-col="name">{t.name}</td>
              <td data-col="volume">{t.minMakerVolume30d}</td>
              <td data-col="uptime">{t.minUptimePct}%</td>
              <td data-col="spread">{t.maxSpreadAtDepthBps} bps</td>
              <td data-col="rebate">{t.rebateBps} bps</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid gap-x-4 gap-y-1 text-sm md:grid-cols-[max-content_1fr]">
        <dt className="text-fg-2">Max spread</dt>
        <dd data-obligation="max-spread">{terms.maxSpreadBps} bps</dd>
        <dt className="text-fg-2">Min depth</dt>
        <dd data-obligation="min-depth">{terms.minDepth}</dd>
        <dt className="text-fg-2">Min uptime</dt>
        <dd data-obligation="min-uptime">{terms.minUptimePct}%</dd>
        <dt className="text-fg-2">Cancel-to-fill ceiling</dt>
        <dd data-obligation="cancel-ratio-ceiling">{terms.cancelToFillCeiling}</dd>
        <dt className="text-fg-2">Clawback window</dt>
        <dd data-obligation="clawback-window">{terms.clawbackWindowDays} days</dd>
        <dt className="text-fg-2">Equal-access criteria</dt>
        <dd data-obligation="equal-access">{terms.equalAccessCriteria}</dd>
      </dl>
    </div>
  );
}

const emptyTier = (): Record<keyof TierInput, string> => ({
  name: '',
  minMakerVolume30d: '',
  minUptimePct: '',
  maxSpreadAtDepthBps: '',
  rebateBps: '',
});

function ProposeTerms({ terms }: { terms: TermsRow | null }) {
  const [tiers, setTiers] = useState(() => Array.from({ length: TIER_ROWS }, emptyTier));
  const [maxSpreadBps, setMaxSpread] = useState('');
  const [minDepth, setMinDepth] = useState('');
  const [minUptimePct, setMinUptime] = useState('');
  const [cancelToFillCeiling, setCeiling] = useState('');
  const [clawbackWindowDays, setWindow] = useState('');
  const [equalAccessCriteria, setEqualAccess] = useState('');

  // Tier 1 is always sent, so a blank one is refused by name; a later row left wholly empty is not a tier.
  const draft = (): TermsInput => ({
    tiers: tiers.filter((t, i) => i === 0 || Object.values(t).some((v) => v.trim() !== '')),
    maxSpreadBps,
    minDepth,
    minUptimePct,
    cancelToFillCeiling,
    clawbackWindowDays,
    equalAccessCriteria,
  });
  const setTier = (i: number, key: keyof TierInput) => (v: string) =>
    setTiers((all) => all.map((t, j) => (j === i ? { ...t, [key]: v } : t)));
  const check = () => {
    const c = checkTerms(draft());
    return c.ok ? null : { code: c.code, message: `${c.message}.` };
  };

  return (
    <TwoPersonForm
      room="maker-programme"
      label="Programme terms"
      proposeLabel="Propose terms"
      applyLabel="Apply approved terms"
      confirmTitle="Write the maker programme terms?"
      confirmLabel="Write terms"
      consequence="These terms become the programme's current version. Members and launch plans are read against them. The approval is used up."
      check={check}
      proposeBody={() => ({ action: 'propose-terms', draft: draft() })}
      applyBody={(approvalId) => ({ action: 'apply-terms', draft: draft(), approvalId })}
      canApply
    >
      {tiers.map((t, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3" data-tier-input={i + 1}>
          <Field label={`Tier ${i + 1} name`} value={t.name} onChange={setTier(i, 'name')} />
          <Field
            label={`Tier ${i + 1} 30-day maker volume`}
            value={t.minMakerVolume30d}
            onChange={setTier(i, 'minMakerVolume30d')}
            inputMode="decimal"
          />
          <Field
            label={`Tier ${i + 1} uptime share (%)`}
            value={t.minUptimePct}
            onChange={setTier(i, 'minUptimePct')}
            inputMode="decimal"
          />
          <Field
            label={`Tier ${i + 1} spread at depth (bps)`}
            value={t.maxSpreadAtDepthBps}
            onChange={setTier(i, 'maxSpreadAtDepthBps')}
            inputMode="numeric"
          />
          <Field label={`Tier ${i + 1} rebate (bps)`} value={t.rebateBps} onChange={setTier(i, 'rebateBps')} inputMode="numeric" />
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Max spread (bps)" value={maxSpreadBps} onChange={setMaxSpread} inputMode="numeric" />
        <Field label="Min depth" value={minDepth} onChange={setMinDepth} inputMode="decimal" />
        <Field label="Min uptime (%)" value={minUptimePct} onChange={setMinUptime} inputMode="decimal" />
        <Field label="Cancel-to-fill ceiling" value={cancelToFillCeiling} onChange={setCeiling} inputMode="decimal" />
        <Field label="Clawback window (days)" value={clawbackWindowDays} onChange={setWindow} inputMode="numeric" />
        <Field label="Equal-access criteria" value={equalAccessCriteria} onChange={setEqualAccess} wide />
      </div>
      <p className="text-xs text-fg-2">
        This proposes v{Number(terms?.version ?? '0') + 1}
        {terms ? `, after v${terms.version}` : ', the first terms'}. Every value is the owner&apos;s or a labelled TEST value; a blank term
        is refused by name.
      </p>
    </TwoPersonForm>
  );
}

function Members({ members, terms }: { members: readonly MemberRow[]; terms: TermsRow | null }) {
  const tiers = new Set((terms?.tiers ?? []).map((t) => t.name));
  if (members.length === 0)
    return (
      <p className="text-sm text-fg-2" data-members="none">
        No member admitted.
      </p>
    );
  return (
    <table className={TABLE} data-members="list">
      <thead>
        <tr>
          <th scope="col">Account</th>
          <th scope="col">Tier</th>
          <th scope="col">Status</th>
          <th scope="col">Conflict declaration</th>
          <th scope="col">Version</th>
        </tr>
      </thead>
      <tbody>
        {members.map((m) => (
          <tr key={m.accountId} data-member={m.accountId} data-status={m.status}>
            <td className="if-num">{m.accountId}</td>
            <td data-col="tier">
              {m.tier}
              {/* A tier the current terms dropped is named, never shown as current. */}
              {terms && !tiers.has(m.tier) ? <span className="text-fg-2"> (not in terms v{terms.version})</span> : null}
            </td>
            <td data-col="status">{m.status}</td>
            <td data-col="conflict">{m.conflictDeclaration}</td>
            <td data-col="version">
              v{m.version} · terms v{m.termsVersion} · approved by {m.approverId}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProposeMember({ terms, members }: { terms: TermsRow | null; members: readonly MemberRow[] }) {
  const [accountId, setAccount] = useState('');
  const [tier, setTier] = useState('');
  const [status, setStatus] = useState<MemberStatus | ''>('active');
  const [conflictDeclaration, setConflict] = useState('');
  const draft = (): MemberInput => ({ accountId, tier, status: status === '' ? null : status, conflictDeclaration });
  const current = members.find((m) => m.accountId === accountId.trim().toLowerCase());
  const check = () => {
    if (!terms)
      return { code: MAKER_PROGRAMME_TERM_UNSET, message: 'The programme has no terms. Write the terms before admitting a member.' };
    const c = checkMember(draft());
    if (!c.ok) return { code: c.code, message: `${c.message}.` };
    if (!terms.tiers.some((t) => t.name === c.value.tier))
      return { code: MAKER_PROGRAMME_TIER_UNKNOWN, message: `Tier ${c.value.tier} is not in the terms v${terms.version}.` };
    return null;
  };
  return (
    <TwoPersonForm
      room="maker-programme"
      label="Programme member"
      proposeLabel="Propose member"
      applyLabel="Apply approved member"
      confirmTitle="Write this programme member?"
      confirmLabel="Write member"
      consequence="The account's membership takes this tier and status. Only an active member can be named as a maker in a launch plan. The approval is used up."
      check={check}
      proposeBody={() => ({ action: 'propose-member', draft: draft() })}
      applyBody={(approvalId) => ({ action: 'apply-member', draft: draft(), approvalId })}
      canApply={accountId.trim() !== ''}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Member account id" value={accountId} onChange={setAccount} wide />
        <label className="flex flex-col gap-1 text-sm">
          <span>Tier</span>
          <select className="adm-input" aria-label="Tier" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">Choose…</option>
            {(terms?.tiers ?? []).map((t) => (
              <option key={t.name} value={t.name ?? ''}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Status</span>
          <select className="adm-input" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as MemberStatus | '')}>
            <option value="">Not set</option>
            <option value="active">active</option>
            <option value="suspended">suspended</option>
            <option value="exited">exited</option>
          </select>
        </label>
        <Field label="Conflict declaration" value={conflictDeclaration} onChange={setConflict} wide />
      </div>
      <p className="text-xs text-fg-2">
        {accountId.trim()
          ? `This proposes v${Number(current?.version ?? '0') + 1} of this member${current ? `, after v${current.version}` : ', its admission'}.`
          : 'Enter the account to see the version this proposes.'}
      </p>
    </TwoPersonForm>
  );
}

function Clawbacks({ clawbacks }: { clawbacks: readonly ClawbackRow[] }) {
  if (clawbacks.length === 0)
    return (
      <p className="text-sm text-fg-2" data-clawbacks="none">
        No clawback recorded.
      </p>
    );
  return (
    <table className={TABLE} data-clawbacks="list">
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Account</th>
          <th scope="col">Amount</th>
          <th scope="col">State</th>
          <th scope="col">Finding</th>
          <th scope="col">Recorded</th>
        </tr>
      </thead>
      <tbody>
        {clawbacks.map((c) => (
          <tr key={c.id} data-clawback={c.id} data-state={c.state}>
            <td data-col="period">{c.period}</td>
            <td data-col="account" className="if-num">
              {c.accountId}
            </td>
            <td data-col="amount" className="if-num">
              {c.amount} {c.asset}
            </td>
            <td data-col="state">{c.state}</td>
            <td data-col="finding">{c.findingRef}</td>
            <td data-col="recorded">{c.createdAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MakerProgrammeRoom({
  terms,
  members,
  clawbacks,
}: {
  terms: TermsRow | null;
  members: readonly MemberRow[];
  clawbacks: readonly ClawbackRow[];
}) {
  return (
    <div className="flex flex-col gap-6" data-room="maker-programme">
      <PageSection title="Programme terms">
        <Terms terms={terms} />
      </PageSection>
      <PageSection title="Propose terms">
        <ProposeTerms terms={terms} />
      </PageSection>
      <PageSection title="Members">
        <Members members={members} terms={terms} />
        <ProposeMember terms={terms} members={members} />
      </PageSection>
      <PageSection title="Clawback records">
        <Clawbacks clawbacks={clawbacks} />
      </PageSection>
      <PageSection title="Periods and payments">
        <p className="text-sm text-fg-2" data-blocker="maker_settlement_unbuilt">
          Not connected: quality periods, incentive settlement and clawback posting are a separate change. No period has been measured, and
          nothing has been paid or clawed back.
        </p>
      </PageSection>
    </div>
  );
}
