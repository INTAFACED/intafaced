'use client';

import { useState } from 'react';
import { PageSection } from './kit';
import { Field, TwoPersonForm } from './two-person-form';
import { checkPlan, LAUNCH_PLAN_MAKER_UNKNOWN, type PlanInput, type PlanMakerInput } from '@/lib/trade-ops/maker-programme-model';
import type { MarketPlan, MemberRow } from '@/lib/trade-ops/maker-programme-view';

const TABLE = 'w-full border-collapse text-sm [&_td]:py-1 [&_td]:pe-3 [&_th]:py-1 [&_th]:pe-3 [&_th]:text-start [&_td]:text-start';
const MAKER_ROWS = 2;

function Plans({ markets, members }: { markets: readonly MarketPlan[]; members: readonly MemberRow[] }) {
  const memberStatus = new Map(members.map((m) => [m.accountId, m.status]));
  if (markets.length === 0)
    return (
      <p className="text-sm text-fg-2" data-plans="none">
        No spot market is listed.
      </p>
    );
  return (
    <table className={TABLE} data-plans="list">
      <thead>
        <tr>
          <th scope="col">Market</th>
          <th scope="col">Plan state</th>
          <th scope="col">Makers</th>
          <th scope="col">Capital</th>
          <th scope="col">Max spread</th>
          <th scope="col">Min depth</th>
          <th scope="col">Min uptime</th>
          <th scope="col">Inventory band</th>
          <th scope="col">Exit criteria</th>
          <th scope="col">Version</th>
        </tr>
      </thead>
      <tbody>
        {markets.map(({ market, symbol, status, plan }) =>
          plan === null ? (
            <tr key={market} data-plan-market={symbol} data-plan-state="none" data-market-status={status}>
              <td>{symbol}</td>
              <td colSpan={9} className="text-fg-2">
                No plan recorded
              </td>
            </tr>
          ) : (
            <tr
              key={market}
              data-plan-market={symbol}
              data-plan-state={plan.state}
              data-market-status={status}
              data-approval={plan.approvalId}
            >
              <td>{symbol}</td>
              <td data-col="state">{plan.state}</td>
              <td data-col="makers">
                {plan.makers.map((m) => (
                  <span key={m.accountId} className="block">
                    <span data-maker={m.accountId} className="if-num">
                      {m.accountId}
                    </span>
                    {/* A maker suspended or exited since the plan was approved is named, never hidden. */}
                    {memberStatus.get(m.accountId!) !== 'active' ? (
                      <span data-maker-status={m.accountId} className="text-fg-2">
                        {' '}
                        (now {memberStatus.get(m.accountId!) ?? 'not a member'})
                      </span>
                    ) : null}
                  </span>
                ))}
              </td>
              <td data-col="capital">
                {plan.makers.map((m) => (
                  <span key={m.accountId} data-capital={m.accountId} className="if-num block">
                    {m.capital} {m.asset}
                  </span>
                ))}
              </td>
              <td data-col="max-spread">{plan.maxSpreadBps} bps</td>
              <td data-col="min-depth">
                {plan.minDepth} within {plan.depthBandBps} bps
              </td>
              <td data-col="min-uptime">{plan.minUptimePct}%</td>
              <td data-col="inventory-band">
                {plan.inventoryMin} to {plan.inventoryMax}
              </td>
              <td data-col="exit-criteria">
                review {plan.exitReviewDate}; exit if uptime below {plan.exitUptimeBelowPct}% or spread above {plan.exitSpreadAboveBps} bps
              </td>
              <td data-col="version">
                v{plan.version} · approved by {plan.approverId} · {plan.writtenAt}
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

const emptyMaker = (): Record<keyof PlanMakerInput, string> => ({ accountId: '', capital: '', asset: '' });

function ProposePlan({ markets, members }: { markets: readonly MarketPlan[]; members: readonly MemberRow[] }) {
  const [symbol, setSymbol] = useState('');
  const [makers, setMakers] = useState(() => Array.from({ length: MAKER_ROWS }, emptyMaker));
  const [maxSpreadBps, setMaxSpread] = useState('');
  const [minDepth, setMinDepth] = useState('');
  const [depthBandBps, setDepthBand] = useState('');
  const [minUptimePct, setMinUptime] = useState('');
  const [inventoryMin, setInvMin] = useState('');
  const [inventoryMax, setInvMax] = useState('');
  const [exitReviewDate, setExitDate] = useState('');
  const [exitUptimeBelowPct, setExitUptime] = useState('');
  const [exitSpreadAboveBps, setExitSpread] = useState('');

  const row = markets.find((m) => m.symbol === symbol);
  // Maker 1 is always sent, so a blank one is refused by name; a later row left wholly empty is not a maker.
  const draft = (): PlanInput => ({
    makers: makers.filter((m, i) => i === 0 || Object.values(m).some((v) => v.trim() !== '')),
    maxSpreadBps,
    minDepth,
    depthBandBps,
    minUptimePct,
    inventoryMin,
    inventoryMax,
    exitReviewDate,
    exitUptimeBelowPct,
    exitSpreadAboveBps,
  });
  const setMaker = (i: number, key: keyof PlanMakerInput) => (v: string) =>
    setMakers((all) => all.map((m, j) => (j === i ? { ...m, [key]: v } : m)));
  const check = () => {
    if (!row) return { code: 'trade_ops.plan_market_missing', message: 'Choose a market.' };
    const c = checkPlan(draft());
    if (!c.ok) return { code: c.code, message: `${c.message}.` };
    const active = new Set(members.filter((m) => m.status === 'active').map((m) => m.accountId));
    const unknown = c.value.makers.find((m) => !active.has(m.accountId!));
    if (unknown)
      return { code: LAUNCH_PLAN_MAKER_UNKNOWN, message: `Maker ${unknown.accountId} is not an active member of the maker programme.` };
    return null;
  };

  return (
    <TwoPersonForm
      room="launch-liquidity"
      label="Launch-liquidity plan"
      proposeLabel="Propose plan"
      applyLabel="Apply approved plan"
      confirmTitle={`Write ${symbol || 'the market'}'s launch-liquidity plan?`}
      confirmLabel="Write plan"
      consequence="This plan becomes the market's approved version. Capital figures are commitments on record, not balances; nothing is held or moved. The approval is used up."
      check={check}
      proposeBody={() => ({ action: 'propose', market: row?.market ?? '', draft: draft() })}
      applyBody={(approvalId) => ({ action: 'apply', market: row?.market ?? '', draft: draft(), approvalId })}
      canApply={row !== undefined}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>Market</span>
          <select className="adm-input" aria-label="Market" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            <option value="">Choose…</option>
            {markets.map((m) => (
              <option key={m.market} value={m.symbol}>
                {m.symbol}
              </option>
            ))}
          </select>
        </label>
      </div>
      {makers.map((m, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3" data-maker-input={i + 1}>
          <Field label={`Maker ${i + 1} account`} value={m.accountId} onChange={setMaker(i, 'accountId')} wide />
          <Field label={`Maker ${i + 1} capital`} value={m.capital} onChange={setMaker(i, 'capital')} inputMode="decimal" />
          <Field label={`Maker ${i + 1} capital asset`} value={m.asset} onChange={setMaker(i, 'asset')} />
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Max spread (bps)" value={maxSpreadBps} onChange={setMaxSpread} inputMode="numeric" />
        <Field label="Min depth" value={minDepth} onChange={setMinDepth} inputMode="decimal" />
        <Field label="Depth band (bps)" value={depthBandBps} onChange={setDepthBand} inputMode="numeric" />
        <Field label="Min uptime (%)" value={minUptimePct} onChange={setMinUptime} inputMode="decimal" />
        <Field label="Inventory band low" value={inventoryMin} onChange={setInvMin} inputMode="decimal" />
        <Field label="Inventory band high" value={inventoryMax} onChange={setInvMax} inputMode="decimal" />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Exit review date" value={exitReviewDate} onChange={setExitDate} type="date" />
        <Field label="Exit if uptime below (%)" value={exitUptimeBelowPct} onChange={setExitUptime} inputMode="decimal" />
        <Field label="Exit if spread above (bps)" value={exitSpreadAboveBps} onChange={setExitSpread} inputMode="numeric" />
      </div>
      <p className="text-xs text-fg-2">
        {row
          ? `This proposes v${Number(row.plan?.version ?? '0') + 1} for ${row.symbol}${row.plan ? `, after v${row.plan.version}` : ', its first plan'}.`
          : 'Choose a market to see the version this proposes.'}{' '}
        Makers are active members of the maker programme; every figure is the owner&apos;s or a labelled TEST value.
      </p>
    </TwoPersonForm>
  );
}

export function LaunchLiquidityRoom({ markets, members }: { markets: readonly MarketPlan[]; members: readonly MemberRow[] }) {
  return (
    <div className="flex flex-col gap-6" data-room="launch-liquidity">
      <PageSection title="Plans per market">
        <Plans markets={markets} members={members} />
        <p className="text-xs text-fg-2">
          A written plan is approved. Moving it to active when its market opens, and to exited, follows the market&apos;s listing lifecycle,
          which is not connected here; no plan is shown active or exited until that is built.
        </p>
      </PageSection>
      <PageSection title="Propose a plan">
        <ProposePlan markets={markets} members={members} />
      </PageSection>
    </div>
  );
}
