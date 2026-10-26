import { aboutFor } from './about';
import { coinCopy } from './copy';

/** "About {Name}" (UI-SPEC 5.5): static copy for the assets that have approved wording; nothing at all for the rest. */
export function AboutSection({ asset, name }: { asset: string; name: string }) {
  const { t } = coinCopy.useCopy();
  const paragraphs = aboutFor(asset);
  if (!paragraphs) return null;
  return (
    <section id="coin-about" className="coin-about" aria-labelledby="coin-about-title" data-testid="about">
      <h2 id="coin-about-title" data-testid="coin-h2" className="coin-h2 coin-h2--xl">
        {t('About {name}', { name })}
      </h2>
      <div className="coin-card coin-about__card">
        {paragraphs.map((text) => (
          <p key={text}>{text}</p>
        ))}
      </div>
    </section>
  );
}
