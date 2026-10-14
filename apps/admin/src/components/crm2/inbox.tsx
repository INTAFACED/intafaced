'use client';
/** "Waiting on us": who is waiting for a reply or a follow-up, oldest first, in three sections, with a tab per kind of person. */
import { StateBlock, Tabs, TabsList, TabsPanel, TabsTab, TooltipProvider } from '@intafaced/ui';
import { founderName, type FounderOwner } from '../founder-names';
import { InboxRow, RowHeader, type RowVariant } from './inbox-row';
import { INBOX_TABS, emptyQueueNote, sectionQueue, tabCounts, tabRows, type InboxTab, type QueueEntry } from './queue';
import type { RowInfo } from './use-row-info';
import { cn } from '@intafaced/ui';

const variantFor = (tab: InboxTab): RowVariant => (tab === 'investors' ? 'investor' : tab === 'others' ? 'other' : 'mixed');

export function InboxView({
  entries,
  loading,
  error,
  truncated,
  tab,
  onTab,
  userId,
  owners,
  selectedId,
  busy,
  onOpen,
  onRetry,
  info,
  openEnquiries,
  now,
}: {
  entries: QueueEntry[] | null;
  loading: boolean;
  error: string;
  truncated: boolean;
  tab: InboxTab;
  onTab: (tab: InboxTab) => void;
  userId: string;
  owners: FounderOwner[];
  selectedId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onRetry: () => void;
  info: ReadonlyMap<string, RowInfo>;
  /** How many enquiries are open in all, or null while not known. Shown when nobody is waiting. */
  openEnquiries: number | null;
  now: number;
}) {
  if (entries === null) {
    return error ? (
      <StateBlock kind="error" thing="the waiting list" onRetry={onRetry} />
    ) : (
      <StateBlock kind="loading" rows={6} rowHeight={40} label={loading ? 'Loading the waiting list' : undefined} />
    );
  }
  const counts = tabCounts(entries, userId);
  const countLabel = (tabId: InboxTab) => (truncated && tabId === 'all' ? `${counts[tabId]}+` : String(counts[tabId]));
  const rows = tabRows(tab, entries, userId);
  const groups = sectionQueue(rows, now);
  const variant = variantFor(tab);
  const allEmpty = entries.length === 0;
  return (
    <TooltipProvider>
      <Tabs value={tab} onValueChange={(value) => onTab(value as InboxTab)}>
        <TabsList divider className="max-w-full gap-5 overflow-x-auto max-[600px]:gap-4" aria-label="Who is waiting">
          {INBOX_TABS.map((entry) => (
            <TabsTab
              key={entry.value}
              value={entry.value}
              className="gap-2"
              aria-label={`${entry.label}, ${countLabel(entry.value)} waiting`}
            >
              <span aria-hidden="true">
                {entry.value === 'others' ? (
                  <>
                    <span className="max-[600px]:hidden">Everyone else</span>
                    <span className="hidden max-[600px]:inline">Others</span>
                  </>
                ) : (
                  entry.label
                )}
              </span>
              <span aria-hidden="true" className="min-w-5 rounded-pill bg-field px-1.5 text-center text-2xs tabular-nums text-fg-2">
                {countLabel(entry.value)}
              </span>
            </TabsTab>
          ))}
        </TabsList>
        {INBOX_TABS.map((entry) => (
          <TabsPanel key={entry.value} value={entry.value} className="@container pt-3">
            {entry.value !== tab ? null : groups.length === 0 ? (
              <StateBlock
                kind="empty"
                title={allEmpty ? 'Nobody is waiting on you.' : 'Nobody here is waiting on you.'}
                body={allEmpty ? emptyQueueNote(openEnquiries) : `${entries.length.toLocaleString('en-GB')} waiting in the other tabs.`}
              />
            ) : (
              <div className="overflow-hidden rounded-md border border-line">
                <RowHeader variant={variant} />
                {groups.map((group) => (
                  <section key={group.section} aria-labelledby={`inbox-${group.section}`}>
                    <h2
                      id={`inbox-${group.section}`}
                      className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs font-medium tracking-wide text-fg-2 uppercase"
                    >
                      {group.section === 'overdue' ? <span aria-hidden="true" className="size-1.5 rounded-full bg-lime" /> : null}
                      <span className={cn(group.section === 'overdue' && 'text-fg')}>{group.title}</span>
                      <span className="tabular-nums text-fg-3">{group.entries.length}</span>
                    </h2>
                    <ul>
                      {group.entries.map((item) => (
                        <InboxRow
                          key={item.row.id}
                          entry={item}
                          variant={variant}
                          info={info.get(item.row.id)}
                          founder={founderName(owners, item.row.ownerUserId)}
                          now={now}
                          selected={selectedId === item.row.id}
                          disabled={busy}
                          onOpen={onOpen}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </TabsPanel>
        ))}
      </Tabs>
      {truncated ? <p className="mt-2 text-xs text-fg-3">Showing the first 1,000 who are waiting.</p> : null}
    </TooltipProvider>
  );
}
