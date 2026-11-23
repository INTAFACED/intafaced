// volt-room: /more
import { OverviewTemplate } from '@intafaced/ui/lit/templates';
import type { ScreenProps } from '../../app/screen-types';
import { moreCopy } from './copy';
import { doorLabel, roomTitle } from '../../app/navigation';
import { usePreferences } from '../../shared/preferences';
import { allServices, sectionId, visibleSections, web3TileBlockers, type ServiceGroupId } from './tiles';
import { useRoomStates, type RoomState } from './room-state';

/** More (UI-SPEC 5.11): the pages that don't have a tab of their own, as tiles. Only a hidden route is left out. */
export default function MoreScreen(_props: ScreenProps) {
  return <MoreHub states={useRoomStates()} />;
}

/** The hub itself, given each More room tile's state (`useRoomStates`), on the overview template. */
export function MoreHub({ states }: { states: Record<string, RoomState> }) {
  const { t } = moreCopy.useCopy();
  const { language } = usePreferences();
  const groupLabel = (id: ServiceGroupId) => (id === 'Account' || id === 'Web3' || id === 'Information' ? t(id) : doorLabel(id, language));
  return (
    <OverviewTemplate
      title={t('More')}
      state={{ kind: 'ready' }}
      hero={null}
      sections={
        <div className="lt-stack">
          {visibleSections().map(({ section, tiles }) => (
            <section key={section} aria-labelledby={sectionId(section)}>
              <h2 data-testid="more-h2" id={sectionId(section)}>
                {t(section)}
              </h2>
              <ul className="lt-rows">
                {tiles.map(({ id, href, icon: Icon, title, line, web3 }) => (
                  <li key={id}>
                    <a data-testid="more-tile" className="lt-row-link" href={href} data-tile={id}>
                      <span data-testid="more-tile__icon" aria-hidden="true">
                        <Icon size={24} strokeWidth={1.75} />
                      </span>
                      <span className="lt-lines">
                        <span data-testid="more-tile__title">{t(title)}</span>
                        <span data-testid="more-tile__line" className="lt-hint">
                          {web3
                            ? t('Blocked by', {
                                blockers: web3TileBlockers(web3)
                                  .map((key) => t(key))
                                  .join(' · '),
                              })
                            : line && t(line)}
                        </span>
                        {states[id] && <RoomStateLine state={states[id]} />}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section aria-labelledby="more-all-services">
            <h2 data-testid="more-h2" id="more-all-services">
              {t('All services')}
            </h2>
            <p className="lt-hint">{t('Every page in the app, by area')}</p>
            <div className="lt-stack">
              {allServices().map(({ id, rooms }) => (
                <section key={id} aria-labelledby={`more-index-${id}`}>
                  <h3 id={`more-index-${id}`}>{groupLabel(id)}</h3>
                  <ul className="lt-rows">
                    {rooms.map((room) => (
                      <li key={room.path}>
                        <a className="lt-link" href={room.path} data-service={room.path}>
                          {roomTitle(room, language)}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </section>
        </div>
      }
    />
  );
}

/** A More room tile's state: live for an open room, or parked with what it waits on (J-more-catalogue-01 #1). */
function RoomStateLine({ state }: { state: RoomState }) {
  const { t } = moreCopy.useCopy();
  return state.kind === 'live' ? (
    <span data-testid="more-tile__state" className="lt-hint" data-state={state.state}>
      {t(`Room ${state.state}`)}
    </span>
  ) : (
    <span data-testid="more-tile__state" className="lt-hint" data-state="parked" data-blocker={state.blocker}>
      {t(`Room parked ${state.blocker}`)}
    </span>
  );
}
