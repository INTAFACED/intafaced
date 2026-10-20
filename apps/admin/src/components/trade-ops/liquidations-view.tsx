'use client';

import { Badge, EmptyState, Table, type TableColumn } from '@intafaced/ui';
import type { DeskAdlPair, DeskNearThreshold, DeskRung, InsuranceHistory, LiquidationDesk, OwedPayout } from '@/lib/trade-ops/desk-parse';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ReadProblem } from './blocker-panel';

/**
 * The liquidation desk (D-ops-06), read only. Every figure is a row svc-trade wrote or a ledger balance; a figure it
 * cannot know is a dash with the reason, never zero. Nothing here posts, retries or overrides a liquidation.
 */

const when = (iso: string) => iso.replace('T', ' ').slice(0, 19);
const section = 'flex flex-col gap-2';

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className={section} aria-label={title}>
      <h2 className="m-0 text-sm font-medium">{title}</h2>
      <p className="m-0 text-xs text-fg-2">{hint}</p>
      {children}
    </section>
  );
}

const live = (state: string) => state === 'planned' || state === 'posted';

export function LiquidationsView({
  desk,
  insurance,
  symbols,
}: {
  desk: LiquidationDesk;
  insurance: readonly { asset: string; history: Outcome<InsuranceHistory> }[];
  symbols: Readonly<Record<string, string>>;
}) {
  const sym = (id: string) => symbols[id] ?? id;
  const parked = new Set(desk.parked);

  const rungCols: TableColumn<DeskRung>[] = [
    {
      id: 'state',
      header: 'State',
      width: 120,
      value: (r) => r.state,
      cell: (r) => (
        <Badge tone={live(r.state) ? 'warn' : r.state === 'abandoned' ? 'error' : 'neutral'} variant="outline" density="dense">
          {r.state}
        </Badge>
      ),
    },
    { id: 'kind', header: 'Step', width: 120, value: (r) => r.kind },
    { id: 'pos', header: 'Position', value: (r) => r.positionId, cell: (r) => <code className="if-num text-xs">{r.positionId}</code> },
    { id: 'size', header: 'Size', numeric: true, value: (r) => r.fromSize },
    { id: 'margin', header: 'Margin', numeric: true, value: (r) => r.fromMargin },
    { id: 'ins', header: 'From insurance', numeric: true, value: (r) => r.fromInsurance },
    { id: 'at', header: 'Updated (UTC)', width: 170, value: (r) => when(r.updatedAt) },
  ];
  const nearCols: TableColumn<DeskNearThreshold>[] = [
    { id: 'market', header: 'Market', value: (n) => sym(n.marketId) },
    { id: 'side', header: 'Side', width: 80, value: (n) => n.side },
    { id: 'size', header: 'Size', numeric: true, value: (n) => n.size },
    { id: 'mark', header: 'Mark', numeric: true, value: (n) => n.markPrice },
    { id: 'liq', header: 'Liquidation price', numeric: true, value: (n) => n.liqPrice },
    {
      id: 'dist',
      header: 'Distance (bps)',
      numeric: true,
      value: (n) => (n.distanceBps === null ? null : String(n.distanceBps)),
      cell: (n) =>
        n.distanceBps === null ? (
          <span title={n.reason ?? undefined}>— {n.reason ?? ''}</span>
        ) : (
          <span className="if-num">{n.distanceBps}</span>
        ),
    },
    {
      id: 'flag',
      header: 'Parked',
      width: 90,
      value: (n) => (parked.has(n.positionId) ? 'parked' : ''),
      cell: (n) =>
        parked.has(n.positionId) ? (
          <Badge tone="error" variant="outline" density="dense">
            Parked
          </Badge>
        ) : null,
    },
  ];
  const adlCols: TableColumn<DeskAdlPair>[] = [
    { id: 'state', header: 'State', width: 110, value: (p) => p.state },
    {
      id: 'bankrupt',
      header: 'Bankrupt position',
      value: (p) => p.bankruptPositionId,
      cell: (p) => <code className="if-num text-xs">{p.bankruptPositionId}</code>,
    },
    {
      id: 'cand',
      header: 'Counterparty position',
      value: (p) => p.candidatePositionId,
      cell: (p) => <code className="if-num text-xs">{p.candidatePositionId}</code>,
    },
    { id: 'size', header: 'Size', numeric: true, value: (p) => p.size },
    { id: 'price', header: 'Bankruptcy price', numeric: true, value: (p) => p.bankruptcyPrice },
    { id: 'profit', header: 'Counterparty profit', numeric: true, value: (p) => p.candidateProfit },
    { id: 'applied', header: 'Applied (UTC)', width: 170, value: (p) => (p.appliedAt ? when(p.appliedAt) : null) },
  ];
  const owedCols: TableColumn<OwedPayout>[] = [
    { id: 'asset', header: 'Asset', value: (o) => o.assetId },
    { id: 'owed', header: 'Owed to winners', numeric: true, value: (o) => o.owed },
    { id: 'count', header: 'Payouts', numeric: true, value: (o) => String(o.count) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Insurance fund"
        hint="The fund's balance and the draws this service booked against it. Top-ups are not booked by this service, so no history is shown for them."
      >
        {insurance.length === 0 ? (
          <EmptyState variant="empty" size="inline" title="No futures market, so no insurance fund asset to read" />
        ) : (
          insurance.map(({ asset, history }) =>
            history.kind !== 'ok' ? (
              <ReadProblem key={asset} outcome={history} title={`Insurance fund ${asset} not read`} />
            ) : (
              <div key={asset} className="flex flex-col gap-2 border border-line p-3">
                <p className="m-0 text-sm">
                  <span className="font-medium">{history.data.asset}</span> balance{' '}
                  {history.data.balance.value === null ? (
                    <span className="text-fg-2">— ({history.data.balance.reason ?? 'not read'})</span>
                  ) : (
                    <span className="if-num">{history.data.balance.value}</span>
                  )}
                </p>
                <p className="m-0 text-xs text-fg-2">Top-ups: not read ({history.data.topUps.reason}).</p>
                <Table
                  label={`Insurance draws ${asset}`}
                  density="dense"
                  columns={[
                    { id: 'at', header: 'When (UTC)', width: 170, value: (d: InsuranceHistory['draws'][number]) => when(d.at) },
                    { id: 'amount', header: 'Drawn', numeric: true, value: (d) => d.amount },
                    {
                      id: 'pos',
                      header: 'Position',
                      value: (d) => d.positionId,
                      cell: (d) => <code className="if-num text-xs">{d.positionId}</code>,
                    },
                    { id: 'rung', header: 'Rung', value: (d) => d.rungId, cell: (d) => <code className="if-num text-xs">{d.rungId}</code> },
                  ]}
                  rows={history.data.draws}
                  getRowId={(d) => d.rungId}
                  emptyState={<EmptyState variant="empty" size="inline" title="No insurance draws booked" />}
                />
              </div>
            ),
          )
        )}
      </Section>

      <Section
        title="Liquidation steps"
        hint="Newest first. Planned and posted steps are live; abandoned ones are parked for an operator to look at."
      >
        <Table
          label="Liquidation steps"
          density="dense"
          columns={rungCols}
          rows={desk.rungs}
          getRowId={(r) => r.rungId}
          emptyState={<EmptyState variant="empty" size="inline" title="No liquidation steps recorded" />}
        />
        {desk.parked.length > 0 ? (
          <p role="status" className="m-0 text-sm">
            <Badge tone="error" density="dense">
              {desk.parked.length} parked
            </Badge>{' '}
            <span className="text-fg-2">An open position whose latest step was abandoned, or that still carries an old-style claim.</span>
          </p>
        ) : null}
      </Section>

      <Section
        title="Closest to liquidation"
        hint="Open positions by how near their accepted mark is to their liquidation price. A missing price is a dash with its reason."
      >
        <Table
          label="Closest to liquidation"
          density="dense"
          columns={nearCols}
          rows={desk.nearThreshold}
          getRowId={(n) => n.positionId}
          emptyState={<EmptyState variant="empty" size="inline" title="No open futures positions" />}
        />
      </Section>

      <Section title="Auto-deleveraging pairs" hint="Where a bankrupt position was matched against a profitable one.">
        <Table
          label="Auto-deleveraging pairs"
          density="dense"
          columns={adlCols}
          rows={desk.adlPairs}
          getRowId={(p) => p.pairId}
          emptyState={<EmptyState variant="empty" size="inline" title="No auto-deleveraging has happened" />}
        />
      </Section>

      <Section title="Owed to winners" hint="What the clearing pot still owes winners, per asset.">
        <Table
          label="Owed to winners"
          density="dense"
          columns={owedCols}
          rows={desk.owedPayouts}
          getRowId={(o) => o.assetId}
          emptyState={<EmptyState variant="empty" size="inline" title="Nothing owed" />}
        />
      </Section>
    </div>
  );
}
