import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react';
import { navigate } from '../../../../app/location';
import { Button, StateBlock } from '@intafaced/ui';
import { createActivityFeed, fmtAmount, refusalCopy } from '../../../../data';
import { usePreferences } from '../../../../shared/preferences';
import { stamp } from '../../../../screens/money/time';
import { useSession } from '../../../session/session';
import { contactLabel, contactsFrom, readRequests, readSent, removeRequest, requestPath } from '../personal-model';
import { cameraRefusal, payTarget, readCode, scanImage, ScanError, type ScanRefusal } from '../scan';
import { decodedSegment, requestRoomHref, type PersonalRoomMatch } from './rooms';
import { roomsCopy } from './rooms-copy';

/** The room's layout: headline on the left, one card on the right, the way Send and Receive sit. */
function Frame({ title, line, children }: { title: string; line: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div className="if-pay" data-testid="pay-room">
      <div className="pay-grid">
        <header data-testid="pay-hero" className="pay-hero">
          <h1>{title}</h1>
          <p>{line}</p>
        </header>
        <section data-testid="pay-card" className="pay-card" aria-label={title}>
          <div className="pay-body">
            {children}
            <a className="pay-recent__link" href="/pay" data-testid="pay-room-back">
              {t('back')}
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Why a room has nothing behind it yet, always on screen. `slice` is the work that connects it. */
function Blocked({ slice, children }: { slice: string; children: ReactNode }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div className="pay-reason" id="pay-room-reason" role="note" data-testid="pay-reason" data-slice={slice}>
      <p className="pay-reason__title">{t('blockedTitle')}</p>
      <p className="pay-reason__body">{children}</p>
    </div>
  );
}

/** Rows of a fact and its value. A value that is not known says so; it is never filled in. */
function Rows({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="pay-quote">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A control that cannot run yet: visible, off, and tied to the reason on screen. */
function Off({ children, describedBy }: { children: ReactNode; describedBy: string }) {
  return (
    <Button type="button" variant="secondary" size={40} disabled aria-describedby={describedBy}>
      {children}
    </Button>
  );
}

function Section({ title, empty, off, describedBy }: { title: string; empty: string; off: string; describedBy: string }) {
  return (
    <div className="pay-block">
      <h3 className="pay-section-title">{title}</h3>
      <p className="pay-empty">{empty}</p>
      <Off describedBy={describedBy}>{off}</Off>
    </div>
  );
}

function RequestRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const { userId } = useSession();
  const { timeZone } = usePreferences();
  const [gone, setGone] = useState(false);
  const entry = useMemo(() => (userId && id ? (readRequests(userId).find((row) => row.id === id) ?? null) : null), [userId, id, gone]);
  return (
    <Frame title={t('requestTitle')} line={t('requestLine')}>
      {entry ? (
        <>
          <Rows
            rows={[
              [t('requestTo'), entry.to],
              [t('requestAmount'), entry.amount && entry.asset ? `${entry.amount} ${entry.asset}` : t('requestAnyAmount')],
              [t('requestNote'), entry.note ?? t('notSet')],
              [t('requestMade'), <span lang="zxx">{stamp(entry.at, timeZone, Date.now())}</span>],
              [t('requestStatus'), t('requestStatusBody')],
            ]}
          />
          <div className="pay-row-actions">
            <Button variant="secondary" size={40} nativeButton={false} render={<a href={entry.path} />}>
              {t('requestOpen')}
            </Button>
            <Button
              variant="ghost"
              size={40}
              onClick={() => {
                if (userId) removeRequest(userId, entry.id);
                setGone(true);
              }}
            >
              {t('requestRemove')}
            </Button>
          </div>
        </>
      ) : (
        <StateBlock
          kind="empty"
          title={gone ? t('requestRemoved') : t('requestMissingTitle')}
          body={t('requestMissingBody')}
          action={{ label: t('requestOpenRequest'), href: '/pay/request' }}
        />
      )}
      <Blocked slice={slice}>{t('requestReason')}</Blocked>
    </Frame>
  );
}

function ScheduledRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('scheduledTitle')} line={t('scheduledLine')}>
      <Blocked slice={slice}>{t('scheduledReason')}</Blocked>
      <Section title={t('scheduledListTitle')} empty={t('scheduledEmpty')} off={t('scheduledNew')} describedBy="pay-room-reason" />
    </Frame>
  );
}

function ContactsRoom({ slice }: { slice: string }) {
  const copy = roomsCopy.useCopy();
  const { t } = copy;
  const { userId } = useSession();
  const people = useMemo(() => (userId ? contactsFrom(readSent(userId), 50) : []), [userId]);
  return (
    <Frame title={t('contactsTitle')} line={t('contactsLine')}>
      <div className="pay-block" data-testid="contacts-device">
        <h3 className="pay-section-title">{t('contactsRecentTitle')}</h3>
        {people.length === 0 ? (
          <p className="pay-empty">{t('contactsRecentEmpty')}</p>
        ) : (
          <ul className="pay-list">
            {people.map((person) => (
              <li key={person.userId} data-testid="contact-row">
                <div className="pay-list__main">
                  <span>{contactLabel(person)}</span>
                  <span className="pay-list__sub">{copy.t('contactsTimes', { count: String(person.times) })}</span>
                </div>
                <div className="pay-row-actions">
                  <Button
                    variant="secondary"
                    size={32}
                    nativeButton={false}
                    render={<a href={requestPath({ to: person.handle ?? person.userId })} />}
                  >
                    {t('contactsPay')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Section title={t('contactsSaved')} empty={t('contactsSavedEmpty')} off={t('contactsAdd')} describedBy="pay-room-reason" />
      <Section title={t('contactsGroups')} empty={t('contactsGroupsEmpty')} off={t('contactsNewGroup')} describedBy="pay-room-reason" />
      <Section title={t('contactsPools')} empty={t('contactsPoolsEmpty')} off={t('contactsNewPool')} describedBy="pay-room-reason" />
      <Blocked slice={slice}>{t('contactsReason')}</Blocked>
    </Frame>
  );
}

function GroupRoom({ kind, id, slice }: { kind: 'group' | 'pool'; id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const pool = kind === 'pool';
  const rows: Array<readonly [string, string]> = [[t('reference'), id ?? t('notSet')]];
  if (pool) rows.push([t('poolAmount'), t('notSet')], [t('poolPaid'), t('notSet')]);
  return (
    <Frame title={t(pool ? 'poolTitle' : 'groupTitle')} line={t(pool ? 'poolLine' : 'groupLine')}>
      <Rows rows={rows} />
      <Section title={t('members')} empty={t('membersEmpty')} off={t('addMember')} describedBy="pay-room-reason" />
      <Blocked slice={slice}>{t('groupReason')}</Blocked>
    </Frame>
  );
}

function PaymentRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const source = useMemo(() => createActivityFeed(api, { pageSize: 50 }), [api, userId]);
  const feed = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const item = feed.status === 'ready' && id ? (feed.data.items.find((row) => row.id === id || row.txId === id) ?? null) : null;
  const body =
    feed.status === 'loading' ? (
      <StateBlock kind="loading" rows={3} rowHeight={40} label={t('paymentTitle')} />
    ) : feed.status === 'refused' ? (
      (() => {
        const words = refusalCopy(feed.code);
        return <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
      })()
    ) : feed.status === 'error' ? (
      <StateBlock kind="error" title={t('paymentFailed')} onRetry={feed.retry} retryLabel={t('tryAgain')} />
    ) : item ? (
      <>
        <Rows
          rows={[
            [
              t('requestAmount'),
              <span lang="zxx">{`${item.direction === 'out' ? '−' : '+'}${fmtAmount(item.amount, { places: 18 })} ${item.asset}`}</span>,
            ],
            [t('requestMade'), <span lang="zxx">{stamp(item.postedAt, timeZone, Date.now())}</span>],
            [t('linkFrom'), item.counterparty ? `@${item.counterparty.handle}` : t('notSet')],
            [t('reference'), <span lang="zxx">{item.txId}</span>],
          ]}
        />
        <Button variant="secondary" size={40} nativeButton={false} render={<a href={`/money/activity/${encodeURIComponent(item.id)}`} />}>
          {t('paymentReceipt')}
        </Button>
        <p className="pay-hint">{t('paymentReceiptNote')}</p>
      </>
    ) : (
      <StateBlock
        kind="empty"
        title={t('paymentMissingTitle')}
        body={t('paymentMissingBody')}
        action={{ label: t('paymentActivity'), href: '/money/activity?tab=transfers' }}
      />
    );
  return (
    <Frame title={t('paymentTitle')} line={t('paymentLine')}>
      {body}
      <div className="pay-block">
        <Off describedBy="pay-room-reason">{t('paymentProblem')}</Off>
      </div>
      <Blocked slice={slice}>{t('paymentReason')}</Blocked>
    </Frame>
  );
}

function ClaimRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('claimTitle')} line={t('claimLine')}>
      <h3 className="pay-section-title">{t('claimStepsTitle')}</h3>
      <ol className="pay-steps" data-testid="pay-steps">
        {t('claimSteps')
          .split('|')
          .map((step) => (
            <li key={step}>{step}</li>
          ))}
      </ol>
      <Button type="button" variant="primary" size={56} fullWidth disabled aria-describedby="pay-room-reason">
        {t('claimButton')}
      </Button>
      <Blocked slice={slice}>{t('claimReason')}</Blocked>
    </Frame>
  );
}

function CasesRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('casesTitle')} line={t('casesLine')}>
      <Section title={t('casesListTitle')} empty={t('casesEmpty')} off={t('casesOpen')} describedBy="pay-room-reason" />
      <Blocked slice={slice}>{t('casesReason')}</Blocked>
    </Frame>
  );
}

function CaseRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('caseTitle')} line={t('caseLine')}>
      <Rows
        rows={[
          [t('reference'), id ?? t('notSet')],
          [t('caseStatus'), t('notSet')],
        ]}
      />
      <Section title={t('caseMessages')} empty={t('caseMessagesEmpty')} off={t('caseReply')} describedBy="pay-room-reason" />
      <Blocked slice={slice}>{t('casesReason')}</Blocked>
    </Frame>
  );
}

function FactsRoom({ title, line, facts, reason, slice }: { title: string; line: string; facts: string[]; reason: string; slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={title} line={line}>
      <Rows rows={facts.map((fact): readonly [string, string] => [fact, t('notSet')])} />
      <Blocked slice={slice}>{reason}</Blocked>
    </Frame>
  );
}

function PreferencesRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('preferencesTitle')} line={t('preferencesLine')}>
      <form className="pay-body" noValidate onSubmit={(event) => event.preventDefault()}>
        <fieldset className="pay-fieldset" disabled aria-describedby="pay-room-reason">
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="pay-pref-source">
              {t('prefSource')}
            </label>
            <select id="pay-pref-source" className="pay-text" defaultValue="">
              <option value="">{t('notSet')}</option>
            </select>
            <p className="pay-hint">{t('prefSourceHint')}</p>
          </div>
          <label className="pay-field__label">
            <input type="checkbox" /> {t('prefFind')}
          </label>
          <label className="pay-field__label">
            <input type="checkbox" /> {t('prefReceipts')}
          </label>
        </fieldset>
      </form>
      <Blocked slice={slice}>{t('preferencesReason')}</Blocked>
    </Frame>
  );
}

/** How often a camera frame is read for a code. */
const FRAME_MS = 250;

function ScanRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  const [refusal, setRefusal] = useState<ScanRefusal | null>(null);
  const [reading, setReading] = useState(false);
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  const open = (text: string) => {
    try {
      navigate(payTarget(text, window.location.origin));
    } catch (err) {
      setRefusal(err instanceof ScanError ? err.code : 'scan.not_pay_code');
    }
  };

  const picked = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setCamera(false);
    setRefusal(null);
    setReading(true);
    try {
      navigate(await scanImage(file, window.location.origin));
    } catch (err) {
      setRefusal(err instanceof ScanError ? err.code : 'scan.unreadable');
    } finally {
      setReading(false);
      // The same image chosen again after a refusal is read again.
      input.value = '';
    }
  };

  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    void (async () => {
      try {
        if (typeof navigator.mediaDevices?.getUserMedia !== 'function') throw new Error('no camera');
        const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        stream = opened;
        // Stopped while the browser was still asking: release the camera it just gave.
        if (stopped || !video.current) return opened.getTracks().forEach((track) => track.stop());
        video.current.srcObject = opened;
        await video.current.play();
        while (!stopped && video.current) {
          const frame = video.current;
          const text = frame.videoWidth > 0 ? await readCode(frame, frame.videoWidth, frame.videoHeight) : null;
          if (stopped) return;
          if (text) {
            setCamera(false);
            open(text);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
        }
      } catch (err) {
        if (stopped) return;
        setCamera(false);
        setRefusal(cameraRefusal(err));
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
    // `open` only reads the current origin and navigates, so the camera loop needs no newer copy of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  return (
    <Frame title={t('scanTitle')} line={t('scanLine')}>
      <div className="pay-row-actions">
        <Button
          type="button"
          variant="secondary"
          size={40}
          disabled={reading}
          onClick={() => {
            setRefusal(null);
            setCamera(!camera);
          }}
        >
          {camera ? t('scanCameraStop') : t('scanCamera')}
        </Button>
        <Button variant="secondary" size={40} nativeButton={false} render={<a href="/pay/receive" />}>
          {t('scanShow')}
        </Button>
      </div>
      {camera && (
        <>
          <video ref={video} className="pay-scan-video" muted playsInline aria-label={t('scanCameraLabel')} />
          <p className="pay-hint" role="status">
            {t('scanLooking')}
          </p>
        </>
      )}
      <div className="pay-field">
        <label className="pay-field__label" htmlFor="pay-scan-file">
          {t('scanFile')}
        </label>
        <input
          id="pay-scan-file"
          className="pay-text"
          type="file"
          accept="image/*"
          disabled={reading}
          onChange={(event) => void picked(event)}
          data-testid="pay-scan-file"
        />
      </div>
      {reading && (
        <p className="pay-hint" role="status">
          {t('scanReading')}
        </p>
      )}
      {refusal && <StateBlock kind="refused" title={t('scanRefusedTitle')} body={t(refusal)} code={refusal} />}
      <Blocked slice={slice}>{t('scanReason')}</Blocked>
    </Frame>
  );
}

function LinkRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('linkTitle')} line={t('linkLine')}>
      <Rows
        rows={[
          [t('reference'), id ?? t('notSet')],
          [t('linkFrom'), t('notSet')],
          [t('linkAmount'), t('notSet')],
          [t('linkFor'), t('notSet')],
        ]}
      />
      <Button type="button" variant="primary" size={56} fullWidth disabled aria-describedby="pay-room-reason">
        {t('linkPay')}
      </Button>
      <Blocked slice={slice}>
        {t('linkReason')} {t('linkCheckout')}
      </Blocked>
    </Frame>
  );
}

function InvoiceRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Frame title={t('invoiceTitle')} line={t('invoiceLine')}>
      <Rows
        rows={[
          [t('reference'), id ?? t('notSet')],
          [t('invoiceBiller'), t('notSet')],
          [t('invoiceAmount'), t('notSet')],
          [t('invoiceDue'), t('notSet')],
        ]}
      />
      <Button type="button" variant="primary" size={56} fullWidth disabled aria-describedby="pay-room-reason">
        {t('invoicePay')}
      </Button>
      <Blocked slice={slice}>{t('invoiceReason')}</Blocked>
    </Frame>
  );
}

/** One personal Pay room, picked by the matched address. A signed-out visitor is sent to sign in and nothing is read. */
export function PersonalRoom({ match }: { match: PersonalRoomMatch }) {
  const { t } = roomsCopy.useCopy();
  const { session } = useSession();
  if (!session) {
    const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
    return (
      <Frame title={t('pay')} line={t('signIn')}>
        <Button variant="primary" size={56} fullWidth nativeButton={false} render={<a href={loginHref} role="link" />}>
          {t('signInButton')}
        </Button>
      </Frame>
    );
  }
  return <RoomBody match={match} />;
}

function RoomBody({ match }: { match: PersonalRoomMatch }) {
  const { t } = roomsCopy.useCopy();
  const { room, params } = match;
  const slice = room.slice;
  switch (room.id) {
    case 'request':
      return <RequestRoom id={decodedSegment(params.requestId)} slice={slice} />;
    case 'scheduled':
      return <ScheduledRoom slice={slice} />;
    case 'contacts':
      return <ContactsRoom slice={slice} />;
    case 'group':
      return <GroupRoom kind="group" id={decodedSegment(params.groupId)} slice={slice} />;
    case 'pool':
      return <GroupRoom kind="pool" id={decodedSegment(params.poolId)} slice={slice} />;
    case 'payment':
      return <PaymentRoom id={decodedSegment(params.transferId)} slice={slice} />;
    case 'claim':
      return <ClaimRoom slice={slice} />;
    case 'cases':
      return <CasesRoom slice={slice} />;
    case 'case':
      return <CaseRoom id={decodedSegment(params.caseId)} slice={slice} />;
    case 'limits':
      return (
        <FactsRoom
          title={t('limitsTitle')}
          line={t('limitsLine')}
          facts={[t('limitsTier'), t('limitsPerPayment'), t('limitsPerDay'), t('limitsUsedToday')]}
          reason={t('limitsReason')}
          slice={slice}
        />
      );
    case 'fees':
      return (
        <FactsRoom
          title={t('feesTitle')}
          line={t('feesLine')}
          facts={[t('feesSend'), t('feesRequest'), t('feesGlobal')]}
          reason={t('feesReason')}
          slice={slice}
        />
      );
    case 'preferences':
      return <PreferencesRoom slice={slice} />;
    case 'scan':
      return <ScanRoom slice={slice} />;
    case 'link':
      return <LinkRoom id={decodedSegment(params.linkId)} slice={slice} />;
    case 'invoice':
      return <InvoiceRoom id={decodedSegment(params.invoiceId)} slice={slice} />;
  }
}
