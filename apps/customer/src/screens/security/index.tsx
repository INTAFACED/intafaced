import { useState } from 'react';
import { Fingerprint, KeyRound, LifeBuoy, Lock, Smartphone } from 'lucide-react';
import './security.css';
import {
  ApiKeyRecords,
  Button,
  Card,
  Chip,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  isFeatureLive,
  Note,
  refusalCopy,
  Row,
  Rows,
  securityNotesCopy,
  StateBlock,
  stamp,
  TextField,
  usePreferences,
} from './deps';
import { securityScreenCopy } from './copy';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { SessionsCard } from './SessionsCard';
import { useSecurityFlows } from './use-security-flows';

type Flow = ReturnType<typeof useSecurityFlows>;
type Copy = ReturnType<typeof securityScreenCopy.useCopy>['t'];
type Safety = ReturnType<typeof securityNotesCopy.useCopy>['t'];

/** Security (UI-SPEC 5.13): how you sign in, where you're signed in, and a way to your API keys. `?view=api-keys` opens the key list. */
export default function Security({ search }: { search?: string }) {
  return new URLSearchParams(search ?? '').get('view') === 'api-keys' ? <ApiKeysView /> : <SecurityMain />;
}

function ApiKeysView() {
  const { t } = securityScreenCopy.useCopy();
  return (
    <div className="sec">
      <header className="sec-head">
        <a className="sk-link" href="/uc/safe">
          ← {t('Back to security')}
        </a>
        <h1 className="sec-h1">{t('API keys')}</h1>
        <p className="sk-lead">{t('API keys line')}</p>
      </header>
      {/* The key list and its revoke flow are the existing, reviewed view; it needs the old stylesheet scope. */}
      <div className="sec-keys legacy-room">
        <ApiKeyRecords />
      </div>
    </div>
  );
}

function SecurityMain() {
  const { t } = securityScreenCopy.useCopy();
  const w = securityNotesCopy.useCopy().t;
  const flow = useSecurityFlows();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const passkeysLive = isFeatureLive('passkeys');
  const { visibleSetup, blocked } = flow;
  const alreadyOn =
    flow.currentResponse && !flow.currentResponse.answer.ok && flow.currentResponse.answer.code === 'auth.mfa_already_enrolled';

  return (
    <div className="sec">
      <header className="sec-head">
        <h1 className="sec-h1">{t('Security')}</h1>
        <p className="sk-lead">{t('Security lead')}</p>
      </header>

      <Notices flow={flow} w={w} t={t} alreadyOn={Boolean(alreadyOn)} />

      <Card title={t('How you sign in')} lead={t('Sign-in lead')}>
        <Rows label={t('How you sign in')}>
          <Row
            icon={<Lock size={20} strokeWidth={1.75} />}
            title={t('Password')}
            line={t('Password line')}
            action={
              <Button variant="secondary" size={32} onClick={() => setPasswordOpen(true)}>
                {t('Change')}
              </Button>
            }
          />
          <Row
            icon={<Smartphone size={20} strokeWidth={1.75} />}
            title={t('Authenticator app')}
            line={`${t('Authenticator line')} ${t('Authenticator status')}`}
            action={
              visibleSetup ? null : (
                <Button variant="secondary" size={32} disabled={blocked('setup')} onClick={() => flow.open('setup')}>
                  {t('Set up')}
                </Button>
              )
            }
          >
            <Soon label={t('Replace or remove')} chip={t('Coming soon')} />
          </Row>
          {passkeysLive ? (
            <Row
              icon={<Fingerprint size={20} strokeWidth={1.75} />}
              title={t('Passkeys')}
              line={
                flow.resource.status === 'ready' && flow.resource.data.length > 0
                  ? t('Passkey count', { count: String(flow.resource.data.length) })
                  : t('Passkeys line')
              }
              action={
                <Button variant="secondary" size={32} disabled={blocked('options')} onClick={() => flow.open('options')}>
                  {t('Add passkey')}
                </Button>
              }
            >
              <Passkeys flow={flow} />
            </Row>
          ) : null}
          <Row icon={<LifeBuoy size={20} strokeWidth={1.75} />} title={t('Recovery codes')} line={t('Recovery line')}>
            <Soon label={t('New codes')} chip={t('Coming soon')} />
          </Row>
        </Rows>
        {visibleSetup ? <SetupPanel flow={flow} w={w} t={t} /> : null}
      </Card>

      <SessionsCard
        key={`${flow.userId}:${flow.seatVersion}:${flow.sessionBlocked ? 'readonly' : 'writable'}`}
        readOnly={flow.sessionBlocked}
        signOutEverywhereDisabled={blocked('logout')}
        onSignOutEverywhere={() => flow.open('logout')}
      />
      {flow.sessionBlocked ? (
        <Note tone="warn" role="status">
          <p>{w('blockedSessions')}</p>
          <div>
            <Button variant="secondary" size={32} onClick={() => flow.setSeatVersion((value) => value + 1)}>
              {w('inspectSessions')}
            </Button>
          </div>
        </Note>
      ) : null}

      <Card title={t('API keys')}>
        <Rows label={t('API keys')}>
          <Row
            icon={<KeyRound size={20} strokeWidth={1.75} />}
            title={t('Your keys')}
            line={t('API keys line')}
            action={
              <Button variant="secondary" size={32} nativeButton={false} render={<a href="/uc/safe?view=api-keys" />}>
                {t('View keys')}
              </Button>
            }
          />
          <Row title={t('Create keys')} chip={<Chip>{t('Coming soon')}</Chip>} />
        </Rows>
      </Card>

      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <ReviewDialog flow={flow} t={t} w={w} />
    </div>
  );
}

/** An action the service doesn't offer yet: its name and a "Coming soon" chip, no button to press. */
function Soon({ label, chip }: { label: string; chip: string }) {
  return (
    <span className="sec-soon">
      <span>{label}</span>
      <Chip>{chip}</Chip>
    </span>
  );
}

function Passkeys({ flow }: { flow: Flow }) {
  const { t } = securityScreenCopy.useCopy();
  const { timeZone } = usePreferences();
  const { resource, reload, limit, setLimit, blocked, open } = flow;
  if (resource.status === 'loading') return <p className="sk-small">…</p>;
  if (resource.status === 'failed') {
    return (
      <p className="sk-small">
        {t('Could not load')}{' '}
        <button type="button" className="sec-textbtn" onClick={reload}>
          {t('Try again')}
        </button>
      </p>
    );
  }
  if (resource.data.length === 0) return <p className="sk-small">{t('No passkeys')}</p>;
  return (
    <ul className="sec-subrows" aria-label={t('Passkeys')}>
      {resource.data.map((key) => (
        <li key={key.credentialId} className="sec-subrow">
          <span className="sk-small">{t('Passkey added', { time: stamp(key.createdAt, timeZone) })}</span>
          <Button
            variant="ghost"
            size={28}
            disabled={blocked('remove')}
            aria-label={`${t('Remove passkey')}: ${t('Passkey added', { time: stamp(key.createdAt, timeZone) })}`}
            onClick={() => open('remove', key)}
          >
            {t('Remove passkey')}
          </Button>
        </li>
      ))}
      {resource.data.length >= limit && limit < 200 ? (
        <li>
          <Button variant="ghost" size={28} onClick={() => setLimit((value) => Math.min(200, value + 50))}>
            {t('Show more')}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

function SetupPanel({ flow, w, t }: { flow: Flow; w: Safety; t: Copy }) {
  const { visibleSetup, code, setCode, showKey, setShowKey, blocked, confirmSetup, setupHeading } = flow;
  if (!visibleSetup) return null;
  return (
    <div className="sec-setup" data-security-sensitive="true">
      <h3 className="sk-h3" ref={setupHeading} tabIndex={-1}>
        {t('Setup title')}
      </h3>
      <p className="sec-live" role="status" aria-live="polite" aria-atomic="true">
        {!visibleSetup.confirmed ? w('setupReady') : ''}
      </p>
      {!visibleSetup.confirmed ? (
        <>
          <ol className="sec-steps">
            <li>{t('Setup step 1')}</li>
            <li>{t('Setup step 2')}</li>
            <li>{t('Setup step 3')}</li>
          </ol>
          <div>
            <Button variant="secondary" size={32} onClick={() => setShowKey((value) => !value)}>
              {showKey ? w('hideKey') : w('showKey')}
            </Button>
          </div>
          {showKey ? (
            <div className="sec-key">
              <TextField label={w('setupKey')} lang="zxx" readOnly autoComplete="off" mono value={visibleSetup.data.secret} />
              <details>
                <summary className="sk-small">{w('uri')}</summary>
                <code className="sk-mono" lang="zxx">
                  {visibleSetup.data.uri}
                </code>
              </details>
            </div>
          ) : null}
          <form className="sec-code" onSubmit={(event) => void confirmSetup(event)}>
            <TextField
              label={t('Code label')}
              name="security-totp-confirm"
              inputMode="numeric"
              pattern="[0-9]{6}"
              required
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit" variant="primary" size={40} disabled={blocked('confirm')}>
              {t('Confirm')}
            </Button>
          </form>
        </>
      ) : (
        <Note tone="good" role="status">
          <p>{t('Authenticator on')}</p>
        </Note>
      )}
      <details className="sec-codes" open={visibleSetup.confirmed || undefined}>
        <summary className="sk-h3">{t('Recovery codes')}</summary>
        <p className="sk-small">{w('memory')}</p>
        <ul className="sec-codelist">
          {visibleSetup.data.recoveryCodes.map((value) => (
            <li key={value} lang="zxx">
              {value}
            </li>
          ))}
        </ul>
      </details>
      <div>
        <Button variant="ghost" size={32} disabled={blocked('setup')} onClick={() => flow.open('setup')}>
          {w('newSetup')}
        </Button>
      </div>
    </div>
  );
}

/** Notes about what just happened, and about anything sent earlier whose result is still unknown. */
function Notices({ flow, w, t, alreadyOn }: { flow: Flow; w: Safety; t: Copy; alreadyOn: boolean }) {
  const { uncertainty, currentResponse, journal, problem, busy, activeStage } = flow;
  const answer = currentResponse?.answer;
  return (
    <>
      {uncertainty.map((record) => {
        const preparation = record.kind === 'options' || record.kind === 'setup';
        const retained = currentResponse?.guardRetained && currentResponse.record?.requestId === record.requestId;
        const sending =
          busy &&
          activeStage !== null &&
          flow.sameActor(activeStage.intent) &&
          activeStage.record.owner === record.owner &&
          activeStage.record.requestId === record.requestId &&
          activeStage.record.kind === record.kind;
        const heading = sending ? 'sent' : retained ? 'guardRetained' : preparation ? 'preparationUnknown' : 'unknown';
        const kind =
          record.kind === 'remove'
            ? 'removeKind'
            : record.kind === 'confirm'
              ? 'confirmKind'
              : record.kind === 'logout'
                ? 'logoutKind'
                : record.kind;
        return (
          <Note key={record.requestId} tone="warn" role="status">
            <h3 className="sk-h3">{w(heading)}</h3>
            <p>{w(kind)}</p>
            <p>
              {w(
                retained
                  ? 'guardBody'
                  : record.kind === 'options'
                    ? 'optionsBoundary'
                    : record.kind === 'setup'
                      ? 'setupBoundary'
                      : 'unknownBody',
              )}
            </p>
            {!preparation ? <p>{w('lookup')}</p> : null}
            <details>
              <summary>{t('Reference')}</summary>
              <p className="sk-mono">{record.requestId}</p>
            </details>
            <a className="sk-link" href="/support">
              {w('support')}
            </a>
          </Note>
        );
      })}
      {problem || journal.failed ? (
        <Note tone="warn" role="status">
          <p>{w(journal.failed ? 'storage' : problem!)}</p>
        </Note>
      ) : null}
      {answer?.ok && currentResponse?.receipt && currentResponse.receipt !== 'confirmationAccepted' ? (
        <Note tone="good" role="status">
          <p>{w(currentResponse.receipt)}</p>
        </Note>
      ) : null}
      {answer && !answer.ok ? (
        alreadyOn ? (
          <Note role="status">
            <p>{t('Already on')}</p>
          </Note>
        ) : currentResponse?.unconfirmed || answer.reason === 'uncertain' ? (
          <Note tone="warn" role="alert">
            <p>{w('unknownBody')}</p>
          </Note>
        ) : (
          <Note tone="error" role="alert">
            <ResultWords answer={answer} />
          </Note>
        )
      ) : null}
    </>
  );
}

function ResultWords({ answer }: { answer: { ok: false; reason: string; code?: string; message: string } }) {
  const { t } = securityScreenCopy.useCopy();
  if (answer.code && (answer.reason === 'forbidden' || answer.reason === 'error' || answer.reason === 'unauthorized')) {
    const words = refusalCopy(answer.code);
    return (
      <>
        <p>
          <strong>{words.title}</strong>
        </p>
        <p>{words.body}</p>
      </>
    );
  }
  return <p>{t('Could not load')}</p>;
}

function ReviewDialog({ flow, t, w }: { flow: Flow; t: Copy; w: Safety }) {
  const { review, busy, blocked } = flow;
  const shown = review !== null && flow.sameActor(review);
  const kind = review?.kind;
  const title =
    kind === 'remove'
      ? t('Review remove title')
      : kind === 'setup'
        ? t('Review setup title')
        : kind === 'logout'
          ? t('Review logout title')
          : t('Review passkey title');
  const body =
    kind === 'remove'
      ? t('Review remove body')
      : kind === 'setup'
        ? t('Review setup body')
        : kind === 'logout'
          ? t('Review logout body')
          : t('Review passkey body');
  const confirm =
    kind === 'remove'
      ? t('Remove passkey')
      : kind === 'setup'
        ? t('Continue')
        : kind === 'logout'
          ? t('Sign out everywhere')
          : t('Add passkey');
  const { timeZone } = usePreferences();
  return (
    <Dialog
      open={shown}
      onOpenChange={(next) => {
        if (!next) flow.cancelReview();
      }}
    >
      <DialogContent closeLabel={t('Close')}>
        <div className="sk-dialog">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{body}</DialogDescription>
          </DialogHeader>
          {kind === 'setup' ? <p className="sk-small">{w('replacement')}</p> : null}
          {kind === 'remove' && review?.credential ? (
            <p className="sk-small">{t('Passkey added', { time: stamp(review.credential.createdAt, timeZone) })}</p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" size={40} disabled={busy} onClick={flow.cancelReview}>
              {t('Cancel')}
            </Button>
            <Button
              variant={kind === 'remove' || kind === 'logout' ? 'sell' : 'primary'}
              size={40}
              disabled={kind ? blocked(kind) : true}
              onClick={flow.confirmReview}
            >
              {confirm}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
