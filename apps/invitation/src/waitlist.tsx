import React, { useEffect, useState } from 'react';
import { HaloInput } from './components/halo-input';
import { HaloField, HaloFieldLabel, HaloFieldContent, HaloFieldDescription } from './components/halo-field';
import { PrimaryMetal } from './components/primary-metal';
import { LivingBackdrop } from './components/living-backdrop';
import { mutate, query } from '@outreach/transport';
import heroPhone from './vendored/assets/images/outreach/graphite-fins-phone.webp';
import lockupBar from '../../../packages/ui/brand/lockup-topbar.svg';
import './waitlist.css';

/**
 * The waitlist (RC-campaigns-03, J-campaigns-20 #1-#3), at /waitlist on the invitation site. A visitor joins with an
 * email, gets a place in the queue and a link to share; each friend who joins with the link moves them up (more
 * referrals first, ties by who joined first). An operator releases waves of the top N; a released visitor sees their
 * wave here. The page reads svc-identity's public waitlist doors through Edge; it keeps the visitor's own code in the
 * address (and, where storage works, on this device) and never shows another person's email.
 */

type Standing = {
  position: number;
  referralCode: string;
  referredCount: number;
  queueLength: number;
  rank: number | null;
  waiting: number;
  release: { waveNumber: number; releasedAt: string } | null;
};

type Refusal = { code: string; message: string };

const CODE_RE = /^[a-fA-F0-9]{12}$/;
const STORE_KEY = 'intafaced.waitlist.code';

/** Our words for each refusal the doors name. An unnamed failure says so plainly. */
const REFUSAL_COPY: Record<string, string> = {
  'waitlist.invalid': 'Check the email address and try again.',
  'waitlist.unknown_referrer': 'That invitation code is not on the waitlist. Check the link you were sent, or join without it.',
  'waitlist.self_referral': 'You cannot join with your own invitation code.',
  'waitlist.referral_locked': 'This email already joined with a different invitation code; it stays with the first one.',
  'waitlist.not_found': 'This waitlist code was not found. Join with your email to get your own.',
  'waitlist.unbuilt': 'The waitlist is not connected on this site yet.',
  'flag.waitlist.enabled.disabled': 'The waitlist is closed right now.',
  'flag.waitlist.enabled.drop_pending': 'The waitlist has not opened yet.',
  'flag.referral.queue.disabled': 'Invitation codes are switched off right now. You can join without one.',
  'flag.referral.queue.drop_pending': 'Invitation codes are not open yet. You can join without one.',
};

/** The edge client's reasons for a call no service answered; each says what is missing, not "something went wrong". */
const REASON_COPY: Record<string, string> = {
  unreachable: 'The waitlist could not be reached. Check your connection and try again.',
  not_routed: 'The waitlist is not connected on this site yet.',
  not_mounted: 'The waitlist is not connected on this site yet.',
};

function refusalText(refusal: Refusal): string {
  return (
    REFUSAL_COPY[refusal.code] ??
    REASON_COPY[refusal.code] ??
    `The waitlist could not answer (${refusal.code || 'no reason given'}). Try again in a moment.`
  );
}

/**
 * One call through the site's edge client. A service refusal names its code last in the message (`... [code]`), so the
 * last bracketed token is the code; a call no service answered keeps the client's own reason.
 */
async function call<T>(procedure: string, input: unknown, kind: 'query' | 'mutate'): Promise<T> {
  const out = await (kind === 'query' ? query : mutate)('identity', procedure, input);
  if (out.ok) return out.data as T;
  const named = [...String(out.message ?? '').matchAll(/\[([a-z0-9_.]+)\]/g)].pop()?.[1];
  throw { code: named ?? (out.reason === 'error' ? '' : out.reason), message: out.message ?? '' } satisfies Refusal;
}

function readStoredCode(): string | null {
  try {
    const value = window.localStorage.getItem(STORE_KEY);
    return value && CODE_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeCode(code: string): void {
  try {
    window.localStorage.setItem(STORE_KEY, code);
  } catch {
    /* storage unavailable: the address still carries the code */
  }
}

function forgetCode(): void {
  try {
    window.localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

const dateText = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function WaitlistPage() {
  const params = new URLSearchParams(window.location.search);
  const invitedBy = params.get('ref')?.trim() ?? '';
  const [code, setCode] = useState<string | null>(() => {
    const fromUrl = params.get('code');
    return fromUrl && CODE_RE.test(fromUrl) ? fromUrl.toLowerCase() : readStoredCode();
  });
  const [email, setEmail] = useState('');
  const [standing, setStanding] = useState<Standing | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async (which: string) => {
    setBusy(true);
    setRefusal(null);
    try {
      setStanding(await call<Standing>('waitlist.position', { referralCode: which }, 'query'));
    } catch (err) {
      setRefusal(err as Refusal);
      if ((err as Refusal).code === 'waitlist.not_found') {
        // The code is gone: back to the join form, with nothing stale left on screen.
        forgetCode();
        setCode(null);
        setStanding(null);
      }
    } finally {
      setBusy(false);
    }
  };

  // The code in the address (or on this device) is read once, on arrival; a join reads its own code below.
  useEffect(() => {
    if (code) void load(code);
  }, []);

  const join = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    let joined: string;
    try {
      const out = await call<{ referralCode: string }>(
        'waitlist.enroll',
        { email: email.trim(), ...(invitedBy ? { referralCode: invitedBy } : {}) },
        'mutate',
      );
      joined = out.referralCode;
    } catch (err) {
      setRefusal(err as Refusal);
      setBusy(false);
      return;
    }
    storeCode(joined);
    window.history.replaceState(null, '', `/waitlist?code=${joined}`);
    setCode(joined);
    await load(joined);
  };

  const shareLink = standing ? `${window.location.origin}/waitlist?ref=${standing.referralCode}` : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="outreach-page invitation-theme dark" data-framework="react">
      <LivingBackdrop variant="ribbons" photoSrc={heroPhone} dim entrance={false} onReady={() => undefined} />
      <section role="main" className="outreach-workspace" aria-busy={busy} aria-labelledby="waitlist-heading">
        <div className="outreach-form-panel">
          <a className="brand-logo form-logo" href="/join" aria-label="INTAFACED">
            <img src={lockupBar} alt="INTAFACED" width={151} height={24} />
          </a>
          <div className="outreach-eyebrow-row">
            <p className="outreach-eyebrow">Waitlist</p>
          </div>
          {!standing ? (
            <form className="waitlist-join" noValidate onSubmit={join}>
              <h1 id="waitlist-heading">Join the waitlist</h1>
              <p className="outreach-small">
                You get a place in the queue and a link to share. Each friend who joins with your link moves you up. Places are released in
                waves.
              </p>
              {invitedBy && (
                <p className="outreach-small" data-testid="waitlist-invited-by">
                  Invited with code <strong>{invitedBy}</strong>
                </p>
              )}
              <HaloField>
                <HaloFieldLabel htmlFor="waitlist-email">Email address</HaloFieldLabel>
                <HaloFieldContent>
                  <HaloInput
                    id="waitlist-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setEmail(event.target.value)}
                  />
                </HaloFieldContent>
                <HaloFieldDescription>No account needed. We use it only for your place on the waitlist.</HaloFieldDescription>
              </HaloField>
              <PrimaryMetal type="submit" label="Join the waitlist" busyLabel="Joining…" busy={busy} disabled={busy || !email.trim()} />
            </form>
          ) : (
            <div className="waitlist-standing">
              {standing.release ? (
                <>
                  <h1 id="waitlist-heading">You are invited: wave {standing.release.waveNumber}</h1>
                  <p className="outreach-small">
                    Your place was released in wave {standing.release.waveNumber} on {dateText(standing.release.releasedAt)}.
                  </p>
                  <p className="outreach-small">
                    The invitation email is not connected yet, so this page is your invitation. Keep this link to come back to it.
                  </p>
                </>
              ) : (
                <>
                  <h1 id="waitlist-heading">Your place in the queue</h1>
                  {standing.rank === null ? (
                    <p className="outreach-small">Your place could not be read just now. Check again in a moment.</p>
                  ) : (
                    <p className="waitlist-rank" aria-label={`Place ${standing.rank} of ${standing.waiting} waiting`}>
                      <span className="waitlist-rank-number">#{standing.rank}</span>
                      <span className="outreach-small"> of {standing.waiting} waiting</span>
                    </p>
                  )}
                </>
              )}
              <dl className="waitlist-facts">
                <div>
                  <dt>Friends who joined with your link</dt>
                  <dd data-testid="waitlist-referred">{standing.referredCount}</dd>
                </div>
                <div>
                  <dt>You joined as number</dt>
                  <dd>{standing.position}</dd>
                </div>
              </dl>
              <HaloField>
                <HaloFieldLabel htmlFor="waitlist-share">Your invitation link</HaloFieldLabel>
                <HaloFieldContent>
                  <HaloInput id="waitlist-share" readOnly value={shareLink} onFocus={(event) => event.currentTarget.select()} />
                </HaloFieldContent>
                <HaloFieldDescription>
                  More friends move you up. When two people have the same number of friends, whoever joined first is ahead.
                </HaloFieldDescription>
              </HaloField>
              <div className="outreach-actions">
                <button type="button" className="outreach-text-button" onClick={copy}>
                  {copied ? 'Link copied' : 'Copy link'}
                </button>
                <button type="button" className="outreach-text-button" disabled={busy} onClick={() => code && void load(code)}>
                  Check my place again
                </button>
              </div>
            </div>
          )}
          {refusal && (
            <p className="step-error" role="alert" data-code={refusal.code}>
              {refusalText(refusal)}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
