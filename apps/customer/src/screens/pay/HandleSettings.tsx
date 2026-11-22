import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, Field, Switch, useToast } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import {
  changeHandle,
  fetchHandleSettings,
  setHandleDiscoverable,
  useSession,
  type HandleChangeCode,
  type HandleSettings as Settings,
} from './deps';
import { payCopy } from './copy';

type Loaded = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; settings: Settings };

/**
 * Receive's handle settings (PP-send-request-03): change the handle under the owner's lifetime cap, and choose whether
 * people can find this account by typing its handle. Every refusal names the rule or state that refused it; a cap the
 * owner has not published refuses every change and says so, never a made-up number.
 */
export function HandleSettings({ handle, onRenamed }: { handle: string; onRenamed: (handle: string) => void }) {
  const { api } = useSession();
  const toast = useToast();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<{ code: HandleChangeCode | 'failed'; tried: string } | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleFailed, setToggleFailed] = useState<HandleChangeCode | 'failed' | null>(null);
  const inputId = useId();
  const switchLabelId = useId();
  const switchHintId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void fetchHandleSettings(api, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      setLoaded(outcome.kind === 'ok' ? { status: 'ready', settings: outcome.settings } : { status: 'failed' });
    });
    return () => controller.abort();
  }, [api, revision]);

  const settings = loaded.status === 'ready' ? loaded.settings : null;
  // The service's answer wins over the handle the screen first read: a change made in another tab shows here, and the
  // next change names the handle that is really there.
  const current = settings?.handle ?? handle;
  useEffect(() => {
    if (settings && settings.handle !== handle) onRenamed(settings.handle);
  }, [settings, handle, onRenamed]);

  function refusalText(code: HandleChangeCode | 'failed', tried: string): string {
    switch (code) {
      case 'identity.security_locked':
        return payCopy.t('Handle security locked');
      case 'identity.delegated_refused':
        return payCopy.t('Handle delegated');
      case 'auth.account_frozen':
        return payCopy.t('Handle account frozen');
      case 'identity.session_not_live':
        return payCopy.t('Sign in again');
      case 'identity.handle_characters':
        return payCopy.t('Handle rule characters');
      case 'identity.handle_length':
        return payCopy.t('Handle rule length');
      case 'identity.handle_taken':
        return payCopy.t('Handle taken', { handle: tried.trim().replace(/^@/, '') });
      case 'identity.handle_unchanged':
        return payCopy.t('Handle unchanged');
      case 'identity.handle_changed_elsewhere':
        return payCopy.t('Handle changed elsewhere');
      case 'identity.handle_change_cap_unset':
        return payCopy.t('Changes not open');
      case 'identity.handle_change_cap_reached':
        return settings?.changeCap != null
          ? payCopy.t('Changes used up {n}', { n: String(settings.changeCap) })
          : payCopy.t('Handle change failed');
      default:
        return payCopy.t('Handle change failed');
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const tried = draft;
    setSaving(true);
    setRefusal(null);
    const outcome = await changeHandle(api, { handle: tried, fromHandle: current });
    setSaving(false);
    if (outcome.kind === 'ok') {
      setLoaded({ status: 'ready', settings: outcome.settings });
      onRenamed(outcome.settings.handle);
      setOpen(false);
      toast.add({ title: payCopy.t('Handle changed', { handle: outcome.settings.handle }), timeout: 3000 });
      return;
    }
    setRefusal({ code: outcome.kind === 'refused' ? outcome.code : 'failed', tried });
    // The count moved somewhere else, or the cap was reached: read the settings again so the count shown is the service's.
    if (outcome.kind === 'refused' && outcome.code.startsWith('identity.handle_change')) setRevision((n) => n + 1);
  }

  async function toggle(next: boolean) {
    if (toggling) return;
    setToggling(true);
    setToggleFailed(null);
    const outcome = await setHandleDiscoverable(api, next);
    setToggling(false);
    if (outcome.kind === 'ok') setLoaded({ status: 'ready', settings: outcome.settings });
    else setToggleFailed(outcome.kind === 'refused' ? outcome.code : 'failed');
  }

  const left =
    settings === null
      ? null
      : settings.changeCap === null || settings.changesLeft === null
        ? payCopy.t('Changes not open')
        : settings.changesLeft === 0
          ? payCopy.t('Changes used up {n}', { n: String(settings.changeCap) })
          : settings.changesLeft === 1
            ? payCopy.t('Changes left one')
            : payCopy.t('Changes left {n}', { n: String(settings.changesLeft) });

  return (
    <div className="lt-body" data-testid="handle-settings">
      {loaded.status === 'failed' ? (
        <p role="alert">
          {payCopy.t('Handle settings failed')}
          <Button tone="quiet" onClick={() => setRevision((n) => n + 1)}>
            {payCopy.t('Try again')}
          </Button>
        </p>
      ) : null}

      <div className="lt-title-row">
        <div className="lt-field">
          <span id={switchLabelId}>{payCopy.t('Find me label')}</span>
          <span className="lt-hint" id={switchHintId}>
            {settings === null ? payCopy.t('Checking handle') : settings.discoverable ? payCopy.t('Find me on') : payCopy.t('Find me off')}
          </span>
        </div>
        <Switch
          label={payCopy.t('Find me label')}
          aria-labelledby={switchLabelId}
          aria-describedby={switchHintId}
          checked={settings?.discoverable ?? false}
          disabled={settings === null || toggling}
          onChange={(next) => void toggle(next)}
          data-testid="handle-discoverable"
        />
      </div>
      {toggleFailed ? (
        <p role="alert">{toggleFailed === 'failed' ? payCopy.t('Find me failed') : refusalText(toggleFailed, current)}</p>
      ) : null}

      <div className="lt-title-row">
        <span className="lt-hint" data-testid="handle-changes-left">
          {left}
        </span>
        <Button
          tone="secondary"
          disabled={settings === null}
          onClick={() => {
            setDraft(current);
            setRefusal(null);
            setOpen(true);
          }}
        >
          {payCopy.t('Change handle')}
        </Button>
      </div>

      <Sheet open={open} title={payCopy.t('Change your handle')} dismissible={!saving} onClose={() => !saving && setOpen(false)}>
        {open ? (
          <form className="lt-body" onSubmit={(event) => void save(event)} noValidate>
            <p className="lt-description">{payCopy.t('Change handle body')}</p>
            <Field
              id={inputId}
              label={payCopy.t('New handle')}
              hint={left ?? undefined}
              type="text"
              value={draft}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
              aria-invalid={refusal !== null || undefined}
              onChange={(event) => setDraft(event.target.value)}
            />
            {refusal ? <p role="alert">{refusalText(refusal.code, refusal.tried)}</p> : null}
            <div className="lt-actions">
              <Button type="button" tone="quiet" disabled={saving} onClick={() => setOpen(false)}>
                {payCopy.t('Cancel')}
              </Button>
              <Button type="submit" tone="primary" disabled={saving} aria-busy={saving || undefined}>
                {payCopy.t('Save')}
              </Button>
            </div>
          </form>
        ) : null}
      </Sheet>
    </div>
  );
}
