'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  KeyValue,
  Table,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  type TableColumn,
} from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import {
  LEAD_STATE_TEXT,
  LEAD_STATUS_TEXT,
  type LeadApplication,
  type LeadAuditRow,
  type LeadDeskRead,
  type LeadListing,
} from '@/lib/trade-ops/copy-lead';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { OutcomeNotice } from './outcome-notice';

/**
 * Founders vet who may lead copy trading (CB-ops-01, CB-copy-12): the applications queue oldest first, the lead
 * criteria, an approval that needs a second founder before the lead is listed, a rejection whose reason the applicant
 * reads, and suspending a listed lead, every step in the audit. Pooled masters, whitelists, takeovers and levels have
 * their views here with the honest state: none of them is built in svc-trade yet, and their owner values are not set.
 */

const utc = (iso: string) => iso.replace('T', ' ').slice(0, 19);

type Notice = { outcome: Outcome<unknown>; doneText: string } | null;
type Reasoned = { kind: 'reject'; application: LeadApplication } | { kind: 'suspend'; lead: LeadListing };

export function CopyDesk({ initial, userId }: { initial: Outcome<LeadDeskRead>; userId: string }) {
  const [read, setRead] = useState<Outcome<LeadDeskRead>>(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState('');
  const [asking, setAsking] = useState<Reasoned | null>(null);
  const reads = useRef(0);
  const daysId = useId();

  const desk = read.kind === 'ok' ? read.data : null;

  async function load() {
    const n = ++reads.current;
    const out = await tradeOpsAction<LeadDeskRead>('copy', { action: 'read' });
    // A read overtaken by a newer one is dropped.
    if (n === reads.current) setRead(out);
  }

  /** Send one action; the result is said in words and the room is read again, whatever it was. */
  async function act(key: string, body: Record<string, unknown>, doneText: string): Promise<Outcome<unknown>> {
    setBusy(key);
    const outcome = await tradeOpsAction('copy', body);
    setNotice({ outcome, doneText });
    await load();
    setBusy(null);
    return outcome;
  }

  async function saveCriteria(e: FormEvent) {
    e.preventDefault();
    const out = await act('criteria', { action: 'criteria', minTrackRecordDays: days }, 'Criteria saved');
    if (out.kind === 'ok') setDays('');
  }

  const queueColumns: TableColumn<LeadApplication>[] = [
    {
      id: 'at',
      header: 'Applied (UTC)',
      width: 170,
      value: (a) => utc(a.appliedAt),
      cell: (a) => (
        <time data-testid="applied-at" dateTime={a.appliedAt} className="if-num text-xs">
          {utc(a.appliedAt)}
        </time>
      ),
    },
    { id: 'name', header: 'Display name', value: (a) => a.displayName },
    { id: 'user', header: 'Account', value: (a) => a.userId, cell: (a) => <span className="if-num text-xs">{a.userId}</span> },
    {
      id: 'status',
      header: 'Status',
      width: 210,
      value: (a) => LEAD_STATUS_TEXT[a.status],
      cell: (a) => (
        <Badge tone={a.status === 'pending' ? 'neutral' : 'warn'} variant="outline" density="dense">
          {LEAD_STATUS_TEXT[a.status]}
        </Badge>
      ),
    },
    {
      id: 'act',
      header: '',
      headerLabel: 'Actions',
      width: 260,
      value: () => null,
      cell: (a) => (
        <span className="flex flex-wrap gap-2">
          {a.status === 'pending' ? (
            <Button
              size={28}
              variant="primary"
              shape="rounded"
              loading={busy === `approve:${a.id}`}
              disabled={busy !== null}
              onClick={() => void act(`approve:${a.id}`, { action: 'approve', applicationId: a.id }, 'Sent for a second founder')}
            >
              Approve
            </Button>
          ) : null}
          {a.status === 'awaiting_second' && a.proposedBy?.toLowerCase() !== userId.toLowerCase() ? (
            <Button
              size={28}
              variant="primary"
              shape="rounded"
              loading={busy === `confirm:${a.id}`}
              disabled={busy !== null}
              onClick={() => void act(`confirm:${a.id}`, { action: 'confirm', applicationId: a.id }, 'Approved and listed')}
            >
              Confirm approval
            </Button>
          ) : null}
          <Button
            size={28}
            variant="secondary"
            shape="rounded"
            disabled={busy !== null}
            onClick={() => setAsking({ kind: 'reject', application: a })}
          >
            Reject
          </Button>
        </span>
      ),
    },
  ];

  const leadColumns: TableColumn<LeadListing>[] = [
    { id: 'name', header: 'Display name', value: (l) => l.displayName },
    { id: 'ref', header: 'Lead', value: (l) => l.leaderRef, cell: (l) => <span className="if-num text-xs">{l.leaderRef}</span> },
    { id: 'state', header: 'State', width: 130, value: (l) => LEAD_STATE_TEXT[l.state] },
    { id: 'listed', header: 'Listed (UTC)', width: 170, value: (l) => (l.listedAt ? utc(l.listedAt) : null) },
    { id: 'changed', header: 'Changed (UTC)', width: 170, value: (l) => utc(l.stateChangedAt) },
    {
      id: 'act',
      header: '',
      headerLabel: 'Actions',
      width: 110,
      value: () => null,
      cell: (l) =>
        l.state === 'listed' ? (
          <Button size={28} variant="sell" shape="rounded" disabled={busy !== null} onClick={() => setAsking({ kind: 'suspend', lead: l })}>
            Suspend
          </Button>
        ) : null,
    },
  ];

  const auditColumns: TableColumn<LeadAuditRow>[] = [
    { id: 'at', header: 'When (UTC)', width: 170, value: (r) => utc(r.at) },
    { id: 'action', header: 'Action', width: 190, value: (r) => r.action },
    { id: 'operator', header: 'Founder', value: (r) => r.operatorId, cell: (r) => <span className="if-num text-xs">{r.operatorId}</span> },
    { id: 'subject', header: 'Subject', value: (r) => r.subject, cell: (r) => <span className="if-num text-xs">{r.subject}</span> },
    { id: 'reason', header: 'Reason', value: (r) => r.reason },
  ];

  return (
    <div className="flex flex-col gap-4" data-room="copy-trading">
      {read.kind !== 'ok' ? <OutcomeNotice outcome={read} /> : null}
      {notice ? <OutcomeNotice outcome={notice.outcome} doneText={notice.doneText} /> : null}
      <Tabs defaultValue="applications">
        <TabsList divider>
          <TabsTab value="applications">Applications</TabsTab>
          <TabsTab value="leads">Leads</TabsTab>
          <TabsTab value="audit">Audit</TabsTab>
          <TabsTab value="pooled">Pooled masters</TabsTab>
          <TabsTab value="whitelists">Whitelists</TabsTab>
          <TabsTab value="takeovers">Takeovers</TabsTab>
          <TabsTab value="levels">Levels</TabsTab>
        </TabsList>

        <TabsPanel value="applications" className="flex flex-col gap-4 pt-4">
          <form aria-label="Lead criteria" onSubmit={(e) => void saveCriteria(e)} className="flex flex-col gap-3">
            <KeyValue
              density="dense"
              items={[
                {
                  label: 'Minimum track record',
                  value: desk?.queue.criteria
                    ? `${desk.queue.criteria.minTrackRecordDays} days, set ${utc(desk.queue.criteria.setAt)} UTC by ${desk.queue.criteria.setBy}`
                    : 'Not set: an approval is refused until a founder sets it here.',
                },
                {
                  label: 'Measured by the platform',
                  value: 'No: a new lead lists with a self-reported record, so founders check it against the criteria themselves.',
                },
              ]}
            />
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Minimum track record, days" density="dense">
                <Input id={daysId} kind="decimal" precision={0} align="start" value={days} onValueChange={setDays} density="dense" />
              </Field>
              <Button type="submit" size={32} variant="secondary" shape="rounded" loading={busy === 'criteria'} disabled={busy !== null}>
                Save criteria
              </Button>
            </div>
          </form>
          {desk ? (
            desk.queue.applications.length === 0 ? (
              <p className="text-sm text-fg-2">No applications waiting.</p>
            ) : (
              <section aria-label="Lead applications">
                <Table<LeadApplication>
                  label="Lead applications"
                  density="dense"
                  columns={queueColumns}
                  rows={desk.queue.applications}
                  getRowId={(a) => a.id}
                />
              </section>
            )
          ) : null}
        </TabsPanel>

        <TabsPanel value="leads" className="pt-4">
          {desk ? (
            <section aria-label="Leads">
              <Table<LeadListing>
                label="Leads"
                density="dense"
                columns={leadColumns}
                rows={desk.leads}
                getRowId={(l) => l.leaderRef}
                emptyState={<p className="p-4 text-sm text-fg-2">No leads are listed.</p>}
              />
            </section>
          ) : null}
        </TabsPanel>

        <TabsPanel value="audit" className="pt-4">
          {desk ? (
            <section aria-label="Audit">
              <Table<LeadAuditRow>
                label="Audit"
                density="dense"
                columns={auditColumns}
                rows={desk.audit}
                getRowId={(r) => r.id}
                emptyState={<p className="p-4 text-sm text-fg-2">Nothing has been decided on this desk yet.</p>}
              />
            </section>
          ) : null}
        </TabsPanel>

        <TabsPanel value="pooled" className="flex flex-col gap-3 pt-4">
          <p className="text-sm text-fg-2">
            A pooled master runs one pool that followers join. Pools are not built in svc-trade yet (CB-copy-pro-share-03), so no one can
            apply to run one and nothing here can be approved.
          </p>
          <section aria-label="Master applications">
            <Table<{ id: string }>
              label="Master applications"
              density="dense"
              columns={[
                { id: 'at', header: 'Applied (UTC)', value: () => null },
                { id: 'name', header: 'Display name', value: () => null },
                { id: 'pool', header: 'Pool', value: () => null },
                { id: 'status', header: 'Status', value: () => null },
              ]}
              rows={[]}
              getRowId={(r) => r.id}
              emptyState={<p className="p-4 text-sm text-fg-2">No master applications: pools are not built yet.</p>}
            />
          </section>
        </TabsPanel>

        <TabsPanel value="whitelists" className="flex flex-col gap-3 pt-4">
          <KeyValue
            density="dense"
            items={[
              { label: 'Batch limit', value: 'Not set by the owner.' },
              { label: 'Whitelists', value: 'None: pool whitelists are not built yet (CB-copy-pro-share-06), so none can be added.' },
            ]}
          />
        </TabsPanel>

        <TabsPanel value="takeovers" className="flex flex-col gap-3 pt-4">
          <p className="text-sm text-fg-2">Takeovers per pool and day, once pools exist (CB-copy-pro-share-09).</p>
          <section aria-label="Takeovers">
            <Table<{ id: string }>
              label="Takeovers"
              density="dense"
              columns={[
                { id: 'pool', header: 'Pool', value: () => null },
                { id: 'day', header: 'Day (UTC)', value: () => null },
                { id: 'count', header: 'Takeovers', value: () => null },
              ]}
              rows={[]}
              getRowId={(r) => r.id}
              emptyState={<p className="p-4 text-sm text-fg-2">No takeovers: pools are not built yet.</p>}
            />
          </section>
        </TabsPanel>

        <TabsPanel value="levels" className="flex flex-col gap-3 pt-4">
          <KeyValue
            density="dense"
            items={[
              { label: 'Levels', value: 'None: lead levels are not built yet (CB-copy-pro-share-11).' },
              { label: 'Ratio', value: 'Maximum ratio: not set by the platform.' },
            ]}
          />
        </TabsPanel>
      </Tabs>

      <ReasonDialog
        asking={asking}
        busy={busy !== null}
        onClose={() => setAsking(null)}
        onSend={async (reason) => {
          if (!asking) return;
          const out =
            asking.kind === 'reject'
              ? await act('reject', { action: 'reject', applicationId: asking.application.id, reason }, 'Rejected')
              : await act('suspend', { action: 'suspend', leaderRef: asking.lead.leaderRef, reason }, 'Suspended');
          if (out.kind === 'ok') setAsking(null);
        }}
      />
    </div>
  );
}

/** A rejection or a suspension, with the reason the audit keeps (and, for a rejection, the applicant reads). */
function ReasonDialog(props: { asking: Reasoned | null; busy: boolean; onClose: () => void; onSend: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const id = useId();
  const verb = props.asking?.kind === 'suspend' ? 'Suspend' : 'Reject';
  const who = props.asking ? (props.asking.kind === 'reject' ? props.asking.application.displayName : props.asking.lead.displayName) : '';
  return (
    <Dialog
      open={props.asking !== null}
      onOpenChange={(open) => {
        if (open || props.busy) return;
        setReason('');
        props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{verb === 'Reject' ? `Reject ${who}?` : `Suspend ${who}?`}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void props.onSend(reason.trim()).then(() => setReason(''));
          }}
        >
          <Field label="Reason" hint="3 to 500 characters, kept in the audit." density="dense">
            <Input id={id} value={reason} onValueChange={setReason} density="dense" />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="secondary" shape="rounded" size={32} disabled={props.busy} />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              variant={verb === 'Suspend' ? 'sell' : 'primary'}
              shape="rounded"
              size={32}
              loading={props.busy}
              disabled={reason.trim().length < 3}
            >
              {verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
