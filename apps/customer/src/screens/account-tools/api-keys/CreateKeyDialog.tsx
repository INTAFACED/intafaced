import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@intafaced/ui';
import { Lock } from 'lucide-react';
import { useSession } from '../../../features/session/session';
import { apiKeysCopy } from './copy';
import {
  classifyCreateFailure,
  createKey,
  nameError,
  revokeKey,
  NAME_MAX,
  parseAllowList,
  type CreateFailureKind,
  type Permission,
} from './model';
import { confirmPasskey } from './passkey-check';
import { SecretOnce } from './SecretOnce';

type Notice = CreateFailureKind | 'passkey-failed';
type Made = { key: string; name: string; access: string };

/**
 * Create a key (OKX "Create API key"): a name, Read and Trade, an optional list of allowed IP addresses, and then the
 * key itself, once. Withdraw is drawn as a locked row because no key can have it.
 */
export function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t, Copy } = apiKeysCopy.useCopy();
  const { api } = useSession();
  const [name, setName] = useState('');
  const [read, setRead] = useState(true);
  const [trade, setTrade] = useState(false);
  const [ipText, setIpText] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<'create' | 'passkey' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [saved, setSaved] = useState(false);
  const working = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const allow = useMemo(() => parseAllowList(ipText), [ipText]);
  const permissions = useMemo(() => {
    const set = new Set<Permission>();
    if (read || trade) set.add('read');
    if (trade) set.add('trade');
    return set;
  }, [read, trade]);
  const problem = nameError(name);
  const accessMissing = permissions.size === 0;
  const blocked = problem !== null || accessMissing || allow.invalid.length > 0;
  const secretOpen = made !== null;

  function reset() {
    setName('');
    setRead(true);
    setTrade(false);
    setIpText('');
    setTouched(false);
    setBusy(null);
    setNotice(null);
    setMade(null);
    setSaved(false);
  }
  function change(next: boolean) {
    // Nothing closes while a request is in flight (a key could be made with nobody watching), and the key is shown
    // once, so the dialog cannot be dismissed by accident until the person says they saved it.
    if (!next && (busy !== null || (secretOpen && !saved))) return;
    if (!next) reset();
    onOpenChange(next);
  }

  async function submit() {
    setTouched(true);
    if (blocked || working.current) return;
    working.current = true;
    setBusy('create');
    setNotice(null);
    const result = await createKey(api, { name, permissions, ips: allow.ips });
    working.current = false;
    if (!alive.current) {
      // The person left the page mid-request: nobody can see this key, so it must not be left active.
      if (result.ok) void revokeKey(api, result.data.id);
      return;
    }
    setBusy(null);
    if (result.ok) {
      setMade({
        key: result.data.key,
        name: name.trim(),
        access: permissions.has('trade') ? `${t('Read')}, ${t('Trade')}` : t('Read'),
      });
      onCreated();
      return;
    }
    setNotice(classifyCreateFailure(result));
  }

  async function confirm() {
    if (working.current) return;
    working.current = true;
    setBusy('passkey');
    const result = await confirmPasskey(api);
    working.current = false;
    if (!alive.current) return;
    setBusy(null);
    if (!result.ok) {
      setNotice('passkey-failed');
      return;
    }
    setNotice(null);
    void submit();
  }

  return (
    <Dialog open={open} onOpenChange={change} disablePointerDismissal={secretOpen || busy !== null}>
      <DialogContent className="tools-dialog max-w-lg" showCloseButton={!secretOpen && busy === null} closeLabel={t('cancel')}>
        {made ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('secret title')}</DialogTitle>
              <DialogDescription>{t('secret meta', { name: made.name, access: made.access })}</DialogDescription>
            </DialogHeader>
            <div className="tools-callout tools-callout--warn" role="note">
              <p className="tools-callout__title">{t('secret warning title')}</p>
              <p>{t('secret warning body')}</p>
            </div>
            <SecretOnce secret={made.key} />
            <label className="tools-check tools-check--block">
              <Checkbox checked={saved} onCheckedChange={(value) => setSaved(value === true)} />
              <span>{t('secret saved')}</span>
            </label>
            <DialogFooter>
              <Button disabled={!saved} onClick={() => change(false)}>
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('create title')}</DialogTitle>
              <DialogDescription>{t('create body')}</DialogDescription>
            </DialogHeader>

            <div className="tools-field">
              <label htmlFor="key-name" className="tools-label">
                {t('name label')}
              </label>
              <input
                id="key-name"
                className="tools-input"
                value={name}
                maxLength={NAME_MAX + 20}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={touched && problem !== null}
                aria-describedby="key-name-hint"
                onChange={(event) => setName(event.target.value)}
              />
              <p id="key-name-hint" className={touched && problem ? 'tools-hint tools-hint--bad' : 'tools-hint'}>
                {touched && problem === 'empty' ? t('name empty') : touched && problem === 'long' ? t('name long') : t('name hint')}
              </p>
            </div>

            <fieldset className="tools-field tools-access">
              <legend className="tools-label">{t('access label')}</legend>
              <label className="tools-check">
                <Checkbox checked={read || trade} disabled={trade} onCheckedChange={(value) => setRead(value === true)} />
                <span className="tools-check__text">
                  <span className="tools-check__title">{t('read label')}</span>
                  <span className="tools-hint">{t('read hint')}</span>
                </span>
              </label>
              <label className="tools-check">
                <Checkbox checked={trade} onCheckedChange={(value) => setTrade(value === true)} />
                <span className="tools-check__text">
                  <span className="tools-check__title">{t('trade label')}</span>
                  <span className="tools-hint">{t('trade hint')}</span>
                </span>
              </label>
              <div className="tools-check tools-check--locked" aria-disabled="true">
                <span className="tools-lock" aria-hidden="true">
                  <Lock size={14} strokeWidth={2} />
                </span>
                <span className="tools-check__text">
                  <span className="tools-check__title">{t('withdraw label')}</span>
                  <span className="tools-hint">{t('withdraw hint')}</span>
                </span>
              </div>
              {touched && accessMissing ? <p className="tools-hint tools-hint--bad">{t('access empty')}</p> : null}
            </fieldset>

            <div className="tools-field">
              <label htmlFor="key-ips" className="tools-label">
                {t('ip label')}
              </label>
              <textarea
                id="key-ips"
                className="tools-input tools-input--area tools-mono"
                rows={3}
                value={ipText}
                placeholder={t('ip placeholder')}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={allow.invalid.length > 0}
                aria-describedby="key-ips-hint"
                onChange={(event) => setIpText(event.target.value)}
              />
              <p id="key-ips-hint" className={allow.invalid.length ? 'tools-hint tools-hint--bad' : 'tools-hint'}>
                {allow.invalid.length ? t('ip bad', { list: allow.invalid.slice(0, 3).join(', ') }) : t('ip hint')}
              </p>
              {allow.ips.length === 0 && trade ? <p className="tools-note tools-note--warn">{t('ip open warning')}</p> : null}
            </div>

            <Notices notice={notice} busy={busy} onConfirm={() => void confirm()} />

            <DialogFooter>
              <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => change(false)}>
                {t('cancel')}
              </Button>
              <Button type="submit" loading={busy === 'create'} disabled={busy !== null}>
                {busy === 'create' ? <Copy k="creating" /> : <Copy k="create submit" />}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Notices({ notice, busy, onConfirm }: { notice: Notice | null; busy: 'create' | 'passkey' | null; onConfirm: () => void }) {
  const { t } = apiKeysCopy.useCopy();
  if (!notice) return null;
  if (notice === 'passkey-missing')
    return (
      <div className="tools-callout" role="alert">
        <p className="tools-callout__title">{t('passkey missing title')}</p>
        <p>{t('passkey missing body')}</p>
        <a className="text-link" href="/uc/safe">
          {t('passkey missing action')}
        </a>
      </div>
    );
  if (notice === 'passkey-unconfirmed' || notice === 'passkey-failed')
    return (
      <div className="tools-callout" role="alert">
        <p className="tools-callout__title">{t('passkey unconfirmed title')}</p>
        <p>{notice === 'passkey-failed' ? t('passkey failed') : t('passkey unconfirmed body')}</p>
        <Button size={32} variant="secondary" loading={busy === 'passkey'} disabled={busy !== null} onClick={onConfirm}>
          {busy === 'passkey' ? t('passkey confirming') : t('passkey confirm')}
        </Button>
      </div>
    );
  if (notice === 'uncertain')
    return (
      <div className="tools-callout tools-callout--warn" role="alert">
        <p className="tools-callout__title">{t('uncertain title')}</p>
        <p>{t('uncertain body')}</p>
      </div>
    );
  if (notice === 'signed-out')
    return (
      <div className="tools-callout" role="alert">
        <p>{t('signed out')}</p>
        <a className="text-link" href="/login">
          {t('sign in')}
        </a>
      </div>
    );
  return (
    <p className="tools-note tools-note--bad" role="alert">
      {notice === 'bad-ip' ? t('bad ip') : t('other failed')}
    </p>
  );
}
