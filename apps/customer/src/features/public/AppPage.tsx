import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { useAppStoreLink } from './app-store-link';
import { pagesCopy } from './public-pages-copy';

/**
 * /app on the reading template: one store button when the founders have set an https store link (SP-pages-03); otherwise
 * the page says there is no store release. Either way it shows the real way to keep the web app one tap away.
 */
export function AppPage() {
  const copy = pagesCopy.useCopy();
  const store = useAppStoreLink();
  return (
    <ReadingTemplate
      title={copy.t('appTitle')}
      state={{ kind: 'ready' }}
      body={
        store ? (
          <section aria-labelledby="app-store">
            <h2 id="app-store">{copy.t('appStoreTitle')}</h2>
            <p>{copy.t('appStoreBody')}</p>
            <a className="lt-button lt-button-primary" href={store} rel="noopener noreferrer">
              {copy.t('appStoreOpen')}
            </a>
          </section>
        ) : (
          <section role="status">
            <h2>{copy.t('appNoneTitle')}</h2>
            <p>{copy.t('appNoneBody')}</p>
          </section>
        )
      }
      related={
        <section>
          <h2>{copy.t('appHomeTitle')}</h2>
          <ul>
            <li>{copy.t('appIphone')}</li>
            <li>{copy.t('appAndroid')}</li>
          </ul>
          <a className="lt-button lt-button-primary" href="/money">
            {copy.t('appOpen')}
          </a>
        </section>
      }
    />
  );
}
