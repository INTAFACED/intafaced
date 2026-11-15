import { useState, type FormEvent } from 'react';
import {
  checkOfficialChannel,
  officialChannelsAnswerSchema,
  type OfficialChannelList,
} from '@intafaced/contracts/support-official-channels';
import { Button, Failure, Loading } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';
import { defineCopy } from '../../shared/i18n';
import './help.css';

const copy = defineCopy('public.official-channels', {
  title: 'Official channels',
  intro:
    'The only web addresses, email senders and support channels that are ours. A message from anywhere else is not from us, whatever it looks like.',
  test: 'TEST list: this stack shows a test list, not the owner’s published channels.',
  unpublished: 'The owner has not published the official channel list.',
  domainsTitle: 'Our web addresses',
  sendersTitle: 'Who our email comes from',
  channelsTitle: 'Where to reach us',
  checkTitle: 'Check an address',
  checkBody:
    'Type a web address or an email sender. This only says whether it is on the list above, exactly. It is checked on this page and sent nowhere.',
  checkField: 'Domain or sender address',
  check: 'Check',
  official: '{value} is on our official list.',
  notListed: '{value} is not on our official list. Treat a message from it as not from us.',
  guidesTitle: 'Scam guides',
  scamTactics: 'How scams work',
  spoofedSms: 'Spoofed text messages',
  dusting: 'Unknown tokens and dust in your wallet',
  emailCompromise: 'If your email may be compromised',
  report: 'Report a scam message',
});

const GUIDES = [
  ['kb-security-scam-tactics', 'scamTactics'],
  ['kb-security-spoofed-sms', 'spoofedSms'],
  ['kb-security-dusting', 'dusting'],
  ['kb-security-email-compromise', 'emailCompromise'],
] as const;

/**
 * `/help/official-channels` (I-signin-sessions-26, J-identity-13 #1): the owner's published list of our domains,
 * senders and channels, a check that says whether a typed address is on it exactly (in the browser, no call), and the
 * scam guides. With no list published it says so and the check takes nothing; the guides stay.
 */
export function OfficialChannels() {
  const { t, languageFor } = copy.useCopy();
  const { api } = useSession();
  const { resource, reload } = useResource(
    (signal) => api.query('support', 'officialChannels', undefined, officialChannelsAnswerSchema, { signal }),
    'official-channels',
  );
  const list = resource.status === 'ready' && resource.data.published ? resource.data : null;
  return (
    <div data-testid="official-channels" className="help stack" lang={languageFor('title')}>
      <header>
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
      </header>
      {resource.status === 'loading' && <Loading />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {resource.status === 'ready' && !resource.data.published && (
        <p className="notice" role="status" data-testid="official-channels__unpublished">
          {t('unpublished')}
        </p>
      )}
      {list && <Published list={list} />}
      {resource.status === 'ready' && <Check list={list} />}
      <section aria-labelledby="official-guides">
        <h2 id="official-guides">{t('guidesTitle')}</h2>
        <ul data-testid="official-channels__guides">
          {GUIDES.map(([id, key]) => (
            <li key={id}>
              <a className="text-link" href={`/helpdetail?id=${id}`}>
                {t(key)}
              </a>
            </li>
          ))}
        </ul>
        <p>
          <a className="text-link" href="/support/new?topic=phishing">
            {t('report')}
          </a>
        </p>
      </section>
    </div>
  );
}

function Published({ list }: { list: OfficialChannelList }) {
  const { t } = copy.useCopy();
  return (
    <section data-testid="official-channels__list" aria-label={t('title')}>
      {list.test && (
        <p className="notice" data-testid="official-channels__test">
          {t('test')}
        </p>
      )}
      <h2>{t('domainsTitle')}</h2>
      <ul lang="zxx">
        {list.domains.map((domain) => (
          <li key={domain}>{domain}</li>
        ))}
      </ul>
      {list.senders.length > 0 && (
        <>
          <h2>{t('sendersTitle')}</h2>
          <ul lang="zxx">
            {list.senders.map((sender) => (
              <li key={sender}>{sender}</li>
            ))}
          </ul>
        </>
      )}
      {list.channels.length > 0 && (
        <>
          <h2>{t('channelsTitle')}</h2>
          <ul>
            {list.channels.map((channel) => (
              <li key={channel.url}>
                <span lang="und">{channel.label}</span>: <span lang="zxx">{channel.url}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Check({ list }: { list: OfficialChannelList | null }) {
  const { t } = copy.useCopy();
  const [value, setValue] = useState('');
  const [result, setResult] = useState<ReturnType<typeof checkOfficialChannel> | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!list || value.trim().length === 0) return;
    setResult(checkOfficialChannel(list, value));
  }
  return (
    <section aria-labelledby="official-check">
      <h2 id="official-check">{t('checkTitle')}</h2>
      <p className="muted">{t('checkBody')}</p>
      <form className="stack" onSubmit={submit} noValidate>
        <label className="field">
          <span>{t('checkField')}</span>
          <input
            lang="zxx"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setResult(null);
            }}
            disabled={!list}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="actions">
          <Button type="submit" disabled={!list}>
            {t('check')}
          </Button>
        </div>
      </form>
      {list && result && (
        <p role="status" data-testid="official-channels__result" data-verdict={result.verdict}>
          {result.verdict === 'official' ? t('official', { value: result.shown }) : t('notListed', { value: result.shown })}
        </p>
      )}
    </section>
  );
}
