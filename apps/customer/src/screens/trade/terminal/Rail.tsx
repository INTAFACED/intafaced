/**
 * The workspace rail, on the right edge as on OKX (PRO-TERMINAL-PLAN section 2): workspace slots 1-10, a plus for a new
 * one, a menu for this workspace (reset, rename, copy, delete, add a panel), the lock and maximise buttons.
 */
import { useState, type FormEvent } from 'react';
import { LayoutPanelLeft, Lock, LockOpen, Maximize2, Minimize2, Plus } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@intafaced/ui';
import { terminalCopy } from './copy';
import { PRESETS } from './presets';
import { cleanName, NAME_MAX, type PresetId } from './workspace';

export interface RailActions {
  open(id: string): void;
  create(preset: PresetId): void;
  reset(): void;
  rename(name: string): void;
  copy(name: string): void;
  remove(): void;
  addPanel(type: string): void;
  toggleLock(): void;
  toggleMaximise(): void;
}

export interface RailProps {
  items: Array<{ id: string; name: string }>;
  activeId: string;
  locked: boolean;
  maximised: boolean;
  canSave: boolean;
  canAdd: boolean;
  /** Name of the preset "Reset" returns to; null when this workspace has none. */
  resetPreset: string | null;
  panels: Array<{ type: string; title: string; about: string; status: 'live' | 'preview'; open: boolean }>;
  actions: RailActions;
}

function RailButton({
  label,
  hint,
  children,
  ...rest
}: { label: string; hint?: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" className="tm-rail-btn" aria-label={label} {...rest} />}>{children}</TooltipTrigger>
      <TooltipContent side="left">{hint ?? label}</TooltipContent>
    </Tooltip>
  );
}

function NameDialog({
  open,
  onOpenChange,
  title,
  about,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  about?: string;
  initial: string;
  onSave: (name: string) => void;
}) {
  const { t } = terminalCopy.useCopy();
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!cleanName(name)) return;
    onSave(cleanName(name));
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('Cancel')}>
        <form onSubmit={submit} className="tm-name-form">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {about ? <DialogDescription>{about}</DialogDescription> : null}
          </DialogHeader>
          <label className="tm-name-label">
            <span>{t('Name field')}</span>
            <input
              className="tm-name-input"
              value={name}
              maxLength={NAME_MAX}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" size={40} onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" variant="primary" size={40} disabled={!cleanName(name)}>
              {t('Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Rail({ items, activeId, locked, maximised, canSave, canAdd, resetPreset, panels, actions }: RailProps) {
  const { t } = terminalCopy.useCopy();
  const [dialog, setDialog] = useState<'rename' | 'copy' | 'delete' | null>(null);
  const active = items.find((item) => item.id === activeId);

  return (
    <nav className="tm-rail" aria-label={t('Workspaces')}>
      <ol className="tm-slots">
        {items.map((item, index) => (
          <li key={item.id}>
            <RailButton
              label={t('Workspace slot', { slot: index + 1, name: item.name })}
              hint={item.name}
              aria-current={item.id === activeId ? 'true' : undefined}
              data-active={item.id === activeId || undefined}
              onClick={() => actions.open(item.id)}
            >
              <span className="tm-slot-n">{index + 1}</span>
            </RailButton>
          </li>
        ))}
      </ol>

      <Menu>
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger className="tm-rail-btn" aria-label={t('New workspace')} />}>
            <Plus size={18} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="left">{t('New workspace')}</TooltipContent>
        </Tooltip>
        <MenuContent side="left" align="start" sideOffset={8}>
          <MenuGroup>
            <MenuLabel>{canAdd ? t('New from a preset') : t('Workspace limit')}</MenuLabel>
            {canAdd
              ? PRESETS.map((preset) => (
                  <MenuItem key={preset.id} onClick={() => actions.create(preset.id)}>
                    {preset.name}
                  </MenuItem>
                ))
              : null}
          </MenuGroup>
        </MenuContent>
      </Menu>

      <div className="tm-rail-sep" aria-hidden="true" />

      <Menu>
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger className="tm-rail-btn" aria-label={t('Workspace menu')} />}>
            <LayoutPanelLeft size={18} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="left">{t('Workspace menu')}</TooltipContent>
        </Tooltip>
        <MenuContent side="left" align="start" sideOffset={8} className="tm-menu">
          <MenuGroup>
            <MenuLabel>{active?.name ?? t('Workspace menu')}</MenuLabel>
            {resetPreset ? <MenuItem onClick={actions.reset}>{t('Reset to preset', { preset: resetPreset })}</MenuItem> : null}
            <MenuItem onClick={() => setDialog('rename')}>{t('Rename workspace')}</MenuItem>
            <MenuItem disabled={!canAdd} onClick={() => setDialog('copy')}>
              {t('Save a copy')}
            </MenuItem>
            <MenuItem disabled={items.length <= 1} onClick={() => setDialog('delete')}>
              {t('Delete workspace')}
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuLabel>{t('Add a panel')}</MenuLabel>
            {panels.map((panel) => (
              <MenuItem key={panel.type} disabled={panel.open} onClick={() => actions.addPanel(panel.type)}>
                <span className="tm-menu-item">
                  <span>{panel.title}</span>
                  <span className="tm-menu-note">
                    {panel.open ? t('Panel already open') : panel.status === 'preview' ? t('Preview') : ''}
                  </span>
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
          <p className="tm-menu-foot" role="note">
            {canSave ? t('Saved on this device') : t('Cant save here')}
          </p>
        </MenuContent>
      </Menu>

      <RailButton
        label={locked ? t('Unlock layout') : t('Lock layout')}
        hint={locked ? t('Locked note') : t('Lock layout')}
        aria-pressed={locked}
        onClick={actions.toggleLock}
      >
        {locked ? <Lock size={18} aria-hidden="true" /> : <LockOpen size={18} aria-hidden="true" />}
      </RailButton>
      <RailButton label={maximised ? t('Restore panel') : t('Maximize panel')} aria-pressed={maximised} onClick={actions.toggleMaximise}>
        {maximised ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}
      </RailButton>

      <NameDialog
        key={`rename-${dialog === 'rename'}-${active?.id}`}
        open={dialog === 'rename'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('Name rename title')}
        initial={active?.name ?? ''}
        onSave={actions.rename}
      />
      <NameDialog
        key={`copy-${dialog === 'copy'}-${active?.id}`}
        open={dialog === 'copy'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('Name copy title')}
        about={t('Name copy about')}
        initial={active?.name ?? ''}
        onSave={actions.copy}
      />
      <AlertDialog open={dialog === 'delete'} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Delete workspace title', { name: active?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('Delete workspace body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="secondary" size={40} onClick={() => setDialog(null)}>
              {t('Delete keep')}
            </Button>
            <Button
              variant="primary"
              size={40}
              onClick={() => {
                actions.remove();
                setDialog(null);
              }}
            >
              {t('Delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}
