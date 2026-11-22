import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { ContactCard } from './ContactCard';
import { RoomDirectory } from './RoomDirectory';
import { pagesCopy } from './public-pages-copy';
import { publicCopy } from './public-copy';

/** About on the reading template: the existing statement, then what is actually inside, then how to reach a person. */
export function AboutPage() {
  const { t } = publicCopy.useCopy();
  const copy = pagesCopy.useCopy();
  return (
    <ReadingTemplate
      title={t('A connected view of your money.')}
      description={t('Intafaced brings money, trading, payments and product tools into one account.')}
      state={{ kind: 'ready' }}
      body={
        <section>
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
          <a className="lt-link" href="/register">
            {t('Create an account ↗')}
          </a>
        </section>
      }
      related={
        <section aria-labelledby="about-inside">
          <h2 id="about-inside">{copy.t('insideTitle')}</h2>
          <p>{copy.t('insideIntro')}</p>
          <RoomDirectory />
        </section>
      }
      contact={
        <section aria-labelledby="about-reach">
          <h2 id="about-reach" className="lt-sr">
            {copy.t('reachTitle')}
          </h2>
          <ContactCard />
        </section>
      }
    />
  );
}
