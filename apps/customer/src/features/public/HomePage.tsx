import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { RoomDirectory } from './RoomDirectory';
import { pagesCopy } from './public-pages-copy';
import { publicCopy } from './public-copy';

/** The public landing page (/) on the reading template: what the account is, its four doors, and every room inside today. */
export function HomePage() {
  const { t } = publicCopy.useCopy();
  const pages = pagesCopy.useCopy();
  // The four doors the landing page opens, each with its two lines.
  const doors = [
    { n: '01', href: '/money', name: t('Money'), lines: [t('What you hold.'), t('What you can use.')] },
    { n: '02', href: '/exchange', name: t('Trade'), lines: [t('The full picture.'), t('A considered order.')] },
    { n: '03', href: '/pay', name: t('Pay'), lines: [t('Send and receive.'), t('Keep things moving.')] },
    { n: '04', href: '/more', name: t('More'), lines: [t('Learn. Research.'), t('Find your next step.')] },
  ];
  // The three things the account is built around, each a heading and its line.
  const details = [
    [t('See the funds behind the decision'), t('Available and held funds stay distinct, so you can see what is ready to use.')],
    [t('Keep your market in context'), t('Chart, order book and ticket work together. Review the details before you place an order.')],
    [
      t('Know when something is unavailable'),
      t('Check what is available to your account before you act. Unsupported actions explain what is missing.'),
    ],
  ] as const;
  return (
    <ReadingTemplate
      title={`${t('Money in view.')} ${t('Possibility ahead.')}`}
      description={t('Keep your money, trading and payments connected. A clear everyday account. A trading desk built for focus.')}
      state={{ kind: 'ready' }}
      meta={
        <p>
          <small>{t('ONE ACCOUNT. YOUR NEXT MOVE.')}</small>
        </p>
      }
      body={
        <>
          <section>
            <div className="lt-actions">
              <a className="lt-button lt-button-primary" href="/register">
                {t('Create your account')}
                <span aria-hidden="true">↗</span>
              </a>
              <a className="lt-button lt-button-secondary" href="/exchange">
                {t('Explore the desk')}
              </a>
            </div>
            <p>
              <small>{t('Product availability depends on your account, region and connected services.')}</small>
            </p>
            <div className="lt-reading-main" aria-label={t('Four connected experiences')}>
              {doors.map((door) => (
                <a key={door.href} className="lt-link" href={door.href}>
                  <span>{door.n}</span>
                  <h2>{door.name}</h2>
                  <p>
                    {door.lines[0]}
                    <br />
                    {door.lines[1]}
                  </p>
                </a>
              ))}
            </div>
          </section>
          <section>
            <p>
              <small>{t('BUILT AROUND YOUR WORKFLOW')}</small>
            </p>
            <h2>
              {t('A calm account.')}
              <br />
              {t('A capable desk.')}
            </h2>
            {details.map(([title, body]) => (
              <article key={title}>
                <h3>
                  <span aria-hidden="true">↗</span> {title}
                </h3>
                <p>{body}</p>
              </article>
            ))}
          </section>
        </>
      }
      related={
        <section aria-labelledby="home-inside">
          <h2 id="home-inside">{pages.t('insideTitle')}</h2>
          <p>{pages.t('insideIntro')}</p>
          <RoomDirectory />
        </section>
      }
    />
  );
}
