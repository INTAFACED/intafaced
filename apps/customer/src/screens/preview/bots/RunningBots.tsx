import { Sparkline, StateBlock, StatusTag, Tabs, TabsList, TabsPanel, TabsTab, type StatusKind } from '@intafaced/ui';
import { direction, fmtChangeLine, fmtUsd } from '../../../data/format';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import type { SampleBot, SampleBotKind, SampleBotsRows } from '../../../preview/fixtures/bots';
import { botsCopy } from './copy';
import { botRatio, elapsed } from './model';
import { useSampleTime } from './time';

const stateKind: Record<SampleBot['state'], StatusKind> = { running: 'filled', stopped: 'cancelled', finished: 'working' };
const kindWord: Record<SampleBotKind, 'Grid short' | 'Dca short' | 'Twap short'> = {
  grid: 'Grid short',
  dca: 'Dca short',
  twap: 'Twap short',
};

function Row({ bot, asOf }: { bot: SampleBot; asOf: string }) {
  const { t } = botsCopy.useCopy();
  const time = useSampleTime();
  const ratio = botRatio(bot);
  const dir = direction(bot.profit);
  const run = elapsed(bot.startedAt, bot.endedAt ?? asOf);
  const live = bot.state === 'running';
  return (
    <tr data-bot={bot.id}>
      <th scope="row" className="bots-cell-bot">
        <span className="bots-kind">{t(kindWord[bot.kind])}</span>
        <span className="bots-bot-text">
          <span className="bots-bot-pair">{bot.pair}</span>
          <span className="bots-bot-settings">{bot.settings}</span>
        </span>
      </th>
      <td>
        <StatusTag
          status={stateKind[bot.state]}
          label={bot.state === 'running' ? t('State running') : bot.state === 'stopped' ? t('State stopped') : t('State finished')}
        />
        <span className="bots-sub">
          {live
            ? run.days > 0
              ? t('Running for', { days: run.days, hours: run.hours })
              : t('Running for hours', { hours: run.hours, minutes: run.minutes })
            : time(bot.endedAt ?? bot.startedAt)}
        </span>
      </td>
      <td className="bots-num if-num">{fmtUsd(bot.invested)}</td>
      <td className="bots-num">
        {bot.profit === null ? (
          <span className="if-num">{t('Filled share', { percent: bot.progressPercent ?? 0 })}</span>
        ) : (
          <span className="if-num" data-direction={dir ?? 'flat'}>
            {fmtChangeLine(bot.profit, ratio)}
          </span>
        )}
      </td>
      <td className="bots-spark">
        <Sparkline values={bot.curve} width={96} height={28} baseline={false} label={t('Bot curve label', { pair: bot.pair })} />
      </td>
      <td className="bots-num if-num">{bot.fills}</td>
      <td className="bots-actions">
        {live ? (
          <PreviewActionButton product="bots" variant="secondary" size={28}>
            {t('Stop')}
          </PreviewActionButton>
        ) : null}
        <PreviewActionButton product="bots" variant="ghost" size={28}>
          {t('Details')}
        </PreviewActionButton>
      </td>
    </tr>
  );
}

function Table({ bots, asOf, ended }: { bots: readonly SampleBot[]; asOf: string; ended: boolean }) {
  const { t } = botsCopy.useCopy();
  return (
    <div className="bots-table-wrap">
      <table className="bots-table">
        <caption className="bots-sr">{t('Running heading')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('Col bot')}</th>
            <th scope="col">{ended ? t('Col ended') : t('Col time')}</th>
            <th scope="col" className="bots-num">
              {t('Col invested')}
            </th>
            <th scope="col" className="bots-num">
              {t('Col result')}
            </th>
            <th scope="col">{t('Col curve')}</th>
            <th scope="col" className="bots-num">
              {t('Col fills')}
            </th>
            <th scope="col" className="bots-sr">
              {t('Col actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {bots.map((bot) => (
            <Row key={bot.id} bot={bot} asOf={asOf} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The bots list: running and stopped. Stop and Details open the sheet. */
export function RunningBots({ rows, empty }: { rows: SampleBotsRows; empty: boolean }) {
  const { t } = botsCopy.useCopy();
  const running = empty ? [] : rows.bots.filter((bot) => bot.state === 'running');
  const stopped = empty ? [] : rows.bots.filter((bot) => bot.state !== 'running');
  return (
    <section className="if-preview__panel bots-list" aria-labelledby="bots-list-h" data-testid="bots-list">
      <div className="if-preview__panel-head">
        <h2 className="if-preview__h2" id="bots-list-h">
          {t('Running heading')}
        </h2>
        <PreviewChip />
      </div>
      <Tabs defaultValue="running">
        <TabsList divider>
          <TabsTab value="running">{t('Running tab', { count: running.length })}</TabsTab>
          <TabsTab value="stopped">{t('Stopped tab', { count: stopped.length })}</TabsTab>
        </TabsList>
        <TabsPanel value="running">
          {running.length > 0 ? (
            <Table bots={running} asOf={rows.asOf} ended={false} />
          ) : (
            <StateBlock kind="empty" title={t('Empty running title')} body={t('Empty running body')} />
          )}
        </TabsPanel>
        <TabsPanel value="stopped">
          {stopped.length > 0 ? (
            <Table bots={stopped} asOf={rows.asOf} ended />
          ) : (
            <StateBlock kind="empty" title={t('Empty stopped title')} body={t('Empty stopped body')} />
          )}
        </TabsPanel>
      </Tabs>
    </section>
  );
}
