import type { SupportHelpCentre, SupportHelpCentreTranslationList } from '@intafaced/contracts';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { HelpCentreDeskView } from '@/lib/support/help-centre-server';
import { Failed } from './support-action-parts';

/**
 * HELP CENTRE SETTINGS — the name, theme and languages the public help centre opens with, and the translations still
 * missing, as svc-support answers them.
 *
 * Nothing is built in: a blank owner value reads "Not set". With no language offered the page says "Languages are not
 * set", readers get no language picker, and no translation gap is counted, because a gap is only measured against an
 * offered language.
 */

const THEME_LABEL: Readonly<Record<NonNullable<SupportHelpCentre['theme']>, string>> = {
  system: 'Follows the reader’s device',
  light: 'Light',
  dark: 'Dark',
};

function Settings({ settings }: { settings: SupportHelpCentre }) {
  return (
    <dl className="dk-kv" data-testid="help-centre-current">
      <dt>Name</dt>
      <dd data-testid="help-centre-name">{settings.name ?? 'Not set'}</dd>
      <dt>Theme</dt>
      <dd data-testid="help-centre-theme">{settings.theme ? THEME_LABEL[settings.theme] : 'Not set'}</dd>
      <dt>Languages</dt>
      <dd data-testid="help-centre-languages">
        {settings.languages ? (
          <>
            {settings.languages.join(', ')}
            <span className="dk-muted"> · readers pick among these on an answer</span>
          </>
        ) : (
          <>
            Languages are not set
            <span className="dk-muted"> · readers get no language picker and read in the site language</span>
          </>
        )}
      </dd>
      <dt>Default language</dt>
      <dd>{settings.defaultLanguage ?? 'Not set'}</dd>
      <dt>Last changed</dt>
      <dd>{settings.updatedAt ? `${formatWhen(settings.updatedAt)} (revision ${settings.revision})` : 'Never'}</dd>
    </dl>
  );
}

function Missing({ list }: { list: SupportHelpCentreTranslationList }) {
  if (list.languages === null) {
    return (
      <p className="dk-muted" data-testid="help-centre-missing-none">
        Languages are not set, so no translation gap is counted.
      </p>
    );
  }
  const missing = list.rows.filter((row) => row.state === 'missing');
  return (
    <>
      <p className="dk-muted" data-testid="help-centre-missing-count">
        {missing.length} missing in the first {list.rows.length} of {list.total} article versions × languages.
      </p>
      {missing.length > 0 && (
        <ul className="dk-list" data-testid="help-centre-missing">
          {missing.map((row) => (
            <li key={`${row.articleId}:${row.version}:${row.language}`} data-testid="help-centre-missing-row">
              {row.articleId} version {row.version} · {row.language} · missing
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function HelpCentrePanel({ view }: { view: HelpCentreDeskView }) {
  return (
    <section className="dk-stack" aria-label="Help centre settings" data-testid="help-centre-panel">
      <h2>Help centre</h2>
      <p className="dk-muted">What the public help centre opens with. A setting the owner has not chosen reads “Not set”.</p>
      {view.settings.kind === 'ok' ? (
        <Settings settings={view.settings.data} />
      ) : (
        <Failed name="Help centre settings" part={view.settings} />
      )}
      <h3>Missing translations</h3>
      {view.translations.kind === 'ok' ? (
        <Missing list={view.translations.data} />
      ) : (
        <Failed name="Translations" part={view.translations} />
      )}
      <div className="dk-row">
        <span className="dk-asof">As of {formatAsOf(view.asOf)}</span>
      </div>
    </section>
  );
}
