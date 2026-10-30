import { isTestBuild } from '../../shared/test-build';
import { testerBuildCopy } from './tester-build-copy';
import './public-pages.css';

/**
 * The sign-in page of a test build says how a tester gets in (J-home-ia-11 #2): where the founder vault is and how to
 * print a one-time code. It names files and commands only, never a password, a second-factor secret or a code. A live
 * build serves no TEST banner, so it shows nothing there.
 */
export function TesterBuild() {
  const { t, languageFor } = testerBuildCopy.useCopy();
  if (!isTestBuild()) return null;
  return (
    <section className="pub-notice" aria-labelledby="tester-build-title" data-testid="tester-build" lang={languageFor('title')}>
      <h2 id="tester-build-title">{t('title')}</h2>
      <p>{t('intro')}</p>
      <p>{t('vault')}</p>
      <h3>{t('stepsHeading')}</h3>
      <ol>
        <li>{t('stepConsole')}</li>
        <li>{t('stepPassword')}</li>
        <li>{t('stepCode')}</li>
        <li>{t('stepDevice')}</li>
      </ol>
    </section>
  );
}
