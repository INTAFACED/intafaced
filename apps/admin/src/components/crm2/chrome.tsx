'use client';
/** The frame of the CRM: the title, Refresh, the quiet Tools menu, the section tabs (Inbox, Raise, People) and the phone's bottom tab bar. */
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, cn } from '@intafaced/ui';
import { crmTime } from '@/lib/crm-browser';
import { MAIN_VIEWS, TOOL_LABEL, TOOL_VIEWS, VIEW_NOTE, VIEW_TITLE, isToolView, type CrmViewId, type MainView } from './url-state';

const MAIN_LABEL: Record<MainView, string> = { inbox: 'Inbox', raise: 'Raise', people: 'People' };

function ViewButton({
  view,
  current,
  count,
  onNavigate,
  className,
}: {
  view: MainView;
  current: CrmViewId;
  count?: number | null;
  onNavigate: (view: CrmViewId) => void;
  className?: string;
}) {
  const active = current === view;
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(view)}
      className={cn(
        'relative inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors duration-(--if-t-fast) ease-if',
        'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime',
        active ? 'text-fg' : 'text-fg-2 hover:text-fg',
        className,
      )}
    >
      {MAIN_LABEL[view]}
      {count ? (
        <span aria-hidden="true" className="min-w-5 rounded-pill bg-field px-1.5 text-center text-2xs tabular-nums text-fg-2">
          {count}
        </span>
      ) : null}
      {active ? <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-0.5 bg-fg max-[899px]:hidden" /> : null}
    </button>
  );
}

export function CrmHeader({
  view,
  waiting,
  updatedAt,
  loading,
  onNavigate,
  onRefresh,
}: {
  view: CrmViewId;
  /** How many people are waiting on us, for the Inbox tab. Null until known. */
  waiting: number | null;
  updatedAt: string | null;
  loading: boolean;
  onNavigate: (view: CrmViewId) => void;
  onRefresh: () => void;
}) {
  const tool = isToolView(view);
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-fg max-[600px]:text-xl">{VIEW_TITLE[view]}</h1>
          {VIEW_NOTE[view] ? <p className="mt-1 text-sm text-fg-2">{VIEW_NOTE[view]}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {updatedAt ? <span className="mr-1 text-xs text-fg-3 max-[600px]:hidden">Updated {crmTime(updatedAt)}</span> : null}
          <Button variant="ghost" size={32} className="max-[600px]:h-11" disabled={loading} onClick={onRefresh}>
            Refresh
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size={32}
                  className={cn('max-[600px]:h-11', tool && 'text-fg')}
                  data-active={tool ? 'true' : undefined}
                />
              }
            >
              {tool ? 'Tools ·' : 'Tools'}
              {tool ? <span className="max-[600px]:hidden">{TOOL_LABEL[view]}</span> : null}
            </MenuTrigger>
            <MenuContent align="end">
              {TOOL_VIEWS.map((entry) => (
                <MenuItem key={entry} onClick={() => onNavigate(entry)}>
                  {TOOL_LABEL[entry]}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
      </div>
      <nav aria-label="CRM sections" className="hidden items-center gap-6 border-b border-line min-[900px]:flex">
        {MAIN_VIEWS.map((entry) => (
          <ViewButton
            key={entry}
            view={entry}
            current={view}
            count={entry === 'inbox' ? waiting : null}
            onNavigate={onNavigate}
            className="h-11 text-base"
          />
        ))}
      </nav>
    </header>
  );
}

/** Inbox, Raise and People along the bottom of a phone, hidden while one person fills the screen (their action bar takes the place). */
export function BottomTabs({
  view,
  waiting,
  onNavigate,
}: {
  view: CrmViewId;
  waiting: number | null;
  onNavigate: (view: CrmViewId) => void;
}) {
  return (
    <nav
      aria-label="CRM sections"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] min-[900px]:hidden"
    >
      {MAIN_VIEWS.map((entry) => (
        <ViewButton
          key={entry}
          view={entry}
          current={view}
          count={entry === 'inbox' ? waiting : null}
          onNavigate={onNavigate}
          className={cn('h-14 text-base', view === entry ? 'bg-raised' : '')}
        />
      ))}
    </nav>
  );
}
