import { findRoom, roomDescription, roomTitle } from '../../app/navigation';
import { useSession } from '../session/session';
import { SUPPORT_EMAIL } from '../more/support-contact';
import { supportMailto } from '../more/support-desk';
import { ContactSupport } from './ContactSupport';
import { NoticeDetail, NoticeFeed } from './NoticeFeed';
import { doorSummaries } from './public-catalogue';
import { PARTICIPATION_ROOMS, partnerEnquiryHref } from './public-pages';
import { pagesCopy } from './public-pages-copy';
import { publicCopy } from './public-copy';
import './public-pages.css';

/** /partner: where a partnership enquiry goes. The form is in the invitation app; this page points at it or at an email. */
export function PartnerPage() {
  const copy = pagesCopy.useCopy();
  const form = partnerEnquiryHref(import.meta.env.VITE_JOIN_URL as string | undefined);
  const to = SUPPORT_EMAIL;
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <h1>{copy.t('partnerTitle')}</h1>
        <p className="muted">{copy.t('partnerLead')}</p>
      </header>
      <section className="pub-card" aria-labelledby="partner-form">
        <h2 id="partner-form">{copy.t('partnerFormTitle')}</h2>
        <p>{copy.t(form ? 'partnerFormBody' : 'partnerNoFormBody')}</p>
        {form ? (
          <a className="button button--primary" href={form}>
            {copy.t('partnerOpenForm')} ↗
          </a>
        ) : (
          <>
            <a className="button button--primary" href={supportMailto(to, copy.t('partnerMailSubject'), copy.t('partnerMailBody'))}>
              {copy.t('partnerEmail')}
            </a>
            <p className="muted contact-card__small">
              <span lang="zxx">{to}</span>
            </p>
          </>
        )}
      </section>
      <section className="pub-card" aria-labelledby="partner-include">
        <h2 id="partner-include">{copy.t('partnerIncludeTitle')}</h2>
        <ul>
          <li>{copy.t('partnerInclude1')}</li>
          <li>{copy.t('partnerInclude2')}</li>
          <li>{copy.t('partnerInclude3')}</li>
        </ul>
        <p className="muted">{copy.t('partnerBoundary')}</p>
      </section>
      <section className="pub-card" aria-labelledby="partner-merchant">
        <h2 id="partner-merchant">{copy.t('partnerMerchantTitle')}</h2>
        <p>{copy.t('partnerMerchantBody')}</p>
        <a className="text-link" href="/pay/merchant">
          {copy.t('partnerMerchantOpen')} →
        </a>
      </section>
    </div>
  );
}

/** /notice, /announcement and their detail pages: the published notice feed, read live. */
export function NoticePage({ detail = false, id = null }: { detail?: boolean; id?: string | null }) {
  const copy = pagesCopy.useCopy();
  const { session } = useSession();
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <h1>{copy.t('noticeTitle')}</h1>
      </header>
      {detail ? <NoticeDetail id={id} /> : <NoticeFeed />}
      {detail && (
        <a className="text-link" href="/notice">
          ← {copy.t('noticeBack')}
        </a>
      )}
      <section className="pub-card">
        <h2>{copy.t('noticeAccountTitle')}</h2>
        <p>{copy.t('noticeAccountBody')}</p>
        <a className="text-link" href={session ? '/notifications' : '/login?redirect=%2Fnotifications'}>
          {copy.t(session ? 'noticeInbox' : 'noticeSignIn')} →
        </a>
      </section>
      <section className="pub-card">
        <h2>{copy.t('noticeStuckTitle')}</h2>
        <p>{copy.t('noticeStuckBody')}</p>
        <a className="text-link" href="/help">
          {copy.t('noticeHelp')} →
        </a>
      </section>
    </div>
  );
}

/** /app: there is no store release, so the page says so and shows the real way to keep the web app one tap away. */
export function AppPage() {
  const copy = pagesCopy.useCopy();
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <h1>{copy.t('appTitle')}</h1>
      </header>
      <section className="pub-notice" role="status">
        <h2>{copy.t('appNoneTitle')}</h2>
        <p>{copy.t('appNoneBody')}</p>
      </section>
      <section className="pub-card">
        <h2>{copy.t('appHomeTitle')}</h2>
        <ul>
          <li>{copy.t('appIphone')}</li>
          <li>{copy.t('appAndroid')}</li>
        </ul>
        <a className="button button--primary" href="/money">
          {copy.t('appOpen')}
        </a>
      </section>
    </div>
  );
}

/**
 * Campaigns and activities, for the public /lab page and the signed-in /campaigns room. No campaign service exists, so no
 * campaign, task or prize is shown. What a person can take part in today comes from rooms that do exist.
 */
export function CampaignsOverview({ heading = true, detail = false }: { heading?: boolean; detail?: boolean }) {
  const copy = pagesCopy.useCopy();
  const { session } = useSession();
  return (
    <div className={heading ? 'pub-page' : 'pub-page pub-page--inline'}>
      {heading && (
        <header className="pub-heading">
          <h1>{copy.t('campTitle')}</h1>
        </header>
      )}
      <section className="pub-notice" role="status">
        <h2>{copy.t(detail ? 'campDetailTitle' : 'campNoneTitle')}</h2>
        <p>{copy.t(detail ? 'campDetailBody' : 'campNoneBody')}</p>
        {detail && (
          <a className="text-link" href="/lab">
            ← {copy.t('campBack')}
          </a>
        )}
      </section>
      <section className="pub-card" aria-labelledby="camp-today">
        <h2 id="camp-today">{copy.t('campTodayTitle')}</h2>
        <ul className="pub-list">
          {PARTICIPATION_ROOMS.map(({ path, note }) => {
            const room = findRoom(path);
            return (
              <li key={path}>
                <span>
                  <strong>{room ? roomTitle(room) : path}</strong>
                  <span className="muted">{copy.t(note)}</span>
                  {room && <small className="muted">{roomDescription(room)}</small>}
                </span>
                <a className="text-link" href={session ? path : `/login?redirect=${encodeURIComponent(path)}`}>
                  {copy.t(session ? 'campOpen' : 'campSignIn')} →
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/** The rooms behind each door, read from the app's room list. Used on the landing page and on About. */
export function RoomDirectory({ limit = 6 }: { limit?: number }) {
  const copy = pagesCopy.useCopy();
  const summaries = doorSummaries();
  return (
    <div className="pub-grid">
      {summaries.map((door) => (
        <section className="pub-card pub-door" key={door.door} aria-label={door.label}>
          <div className="pub-door__head">
            <h3>{door.label}</h3>
            <span className="muted">{door.count === 1 ? copy.t('roomsOne') : copy.t('rooms', { count: door.count })}</span>
          </div>
          <ul>
            {door.entries.slice(0, limit).map((entry) => (
              <li key={entry.path}>
                <a className="text-link" href={entry.path}>
                  {entry.title}
                </a>
                <small>{entry.description}</small>
              </li>
            ))}
          </ul>
          {door.count > limit && <p className="muted">{copy.t('andMore', { count: door.count - limit })}</p>}
          <a className="text-link" href={`/${door.door.toLowerCase()}`}>
            {copy.t('openDoor', { door: door.label })} →
          </a>
        </section>
      ))}
    </div>
  );
}

/** About: the existing statement, then what is actually inside, then how to reach a person. */
export function AboutPage() {
  const { t } = publicCopy.useCopy();
  const copy = pagesCopy.useCopy();
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <h1>{t('A connected view of your money.')}</h1>
        <p className="muted">{t('Intafaced brings money, trading, payments and product tools into one account.')}</p>
      </header>
      <section className="public-prose">
        <h2>{t('Four doors. One account.')}</h2>
        <p>
          {t(
            'Money is your everyday starting point. Trade gives you the market and the order details. Pay keeps your payments in context. More brings together learning, research and the rest of the product.',
          )}
        </p>
        <h2>{t('Clear information comes first.')}</h2>
        <p>
          {t(
            'Available funds stay distinct from funds on hold. Missing prices stay missing. Where a service or rail is not connected, the product explains the limitation before you act.',
          )}
        </p>
        <a className="text-link" href="/register">
          {t('Create an account ↗')}
        </a>
      </section>
      <section aria-labelledby="about-inside">
        <h2 id="about-inside">{copy.t('insideTitle')}</h2>
        <p className="muted">{copy.t('insideIntro')}</p>
        <RoomDirectory />
      </section>
      <section aria-labelledby="about-reach">
        <h2 id="about-reach" className="sr-only">
          {copy.t('reachTitle')}
        </h2>
        <ContactSupport />
      </section>
    </div>
  );
}
