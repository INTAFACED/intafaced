import { useState } from 'react';
import { z } from 'zod';
import { academyCurriculumSummarySchema } from '@intafaced/contracts/academy-catalogue';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button } from '../../shared/ui';
import { useApi } from '../session/session';
import { academyRoomPageCopy as copy } from './academy-room-page-copy';
import { lessonHref } from './AcademyLearning';
import { Select, type ActionControls } from './common';

/** A lesson as the room read hands it back: the catalogue's own summary, as the contract declares it. */
export const pinnedLessonSchema = academyCurriculumSummarySchema;
type PinnedLesson = z.infer<typeof pinnedLessonSchema>;
type CalendarSession = { id: string; title: string; status: 'scheduled' | 'live' | 'ended' | 'cancelled'; startsAt: string };

const ok = z.object({ ok: z.literal(true) });

/** RC-academy-06: the lessons the room's host pinned, in the order pinned; the host pins and unpins here. */
export function RoomPinnedLessons({
  roomId,
  lessons,
  isHost,
  action,
  done,
}: {
  roomId: string;
  lessons: readonly PinnedLesson[];
  isHost: boolean;
  action: ActionControls;
  done: () => void;
}) {
  const { t, Copy } = copy.useCopy();
  const api = useApi();
  return (
    <section data-room-pinned-lessons aria-labelledby={`room-pins-${roomId}`}>
      <h3 id={`room-pins-${roomId}`}>
        <Copy k="pinnedTitle" />
      </h3>
      {lessons.length === 0 ? (
        <p data-room-pinned-empty>
          <Copy k="pinnedEmpty" />
        </p>
      ) : (
        <ol className="more-rooms">
          {lessons.map((lesson) => (
            <li key={lesson.slug} className="more-room-link" data-room-pinned-lesson={lesson.slug}>
              <strong>{lesson.title}</strong>
              <p>{lesson.summary}</p>
              <p className="muted">
                <Copy k="pinnedMinutes" params={{ minutes: lesson.estimatedMinutes }} />
              </p>
              <div className="actions">
                <a href={lessonHref(lesson.slug, '')} aria-label={`${t('openLesson')}: ${lesson.title}`}>
                  <Copy k="openLesson" />
                </a>
                {isHost && (
                  <Button
                    variant="secondary"
                    disabled={action.disabled}
                    onClick={() =>
                      action.stage({
                        title: t('unpinTitle'),
                        confirm: t('unpin'),
                        success: t('unpinned'),
                        content: <p>{t('unpinBody', { title: lesson.title })}</p>,
                        run: () => api.mutate('academy', 'unpinLesson', { roomId, itemSlug: lesson.slug }, ok),
                        done,
                      })
                    }
                  >
                    <Copy k="unpin" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {isHost && <PinLessonForm roomId={roomId} pinned={lessons} action={action} done={done} />}
    </section>
  );
}

const catalogueItem = pinnedLessonSchema.pick({ slug: true, title: true });

function PinLessonForm({
  roomId,
  pinned,
  action,
  done,
}: {
  roomId: string;
  pinned: readonly PinnedLesson[];
  action: ActionControls;
  done: () => void;
}) {
  const { t, Copy } = copy.useCopy();
  const api = useApi();
  const [slug, setSlug] = useState('');
  const catalogue = useResource(
    (signal) => api.query('academy', 'curriculum', { limit: 200 }, z.array(catalogueItem), { signal }),
    `room-pin-catalogue:${roomId}`,
  );
  const items = catalogue.resource.status === 'ready' ? catalogue.resource.data : [];
  const open = items.filter((item) => !pinned.some((p) => p.slug === item.slug));
  const chosen = open.find((item) => item.slug === slug);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen) return;
        action.stage({
          title: t('pinTitle'),
          confirm: t('pinConfirm'),
          success: t('pinned'),
          content: <p>{t('pinBody', { title: chosen.title })}</p>,
          run: () => api.mutate('academy', 'pinLesson', { roomId, itemSlug: chosen.slug }, ok),
          done: () => {
            setSlug('');
            done();
          },
        });
      }}
    >
      <Select
        label={t('pinLabel')}
        value={slug}
        onChange={setSlug}
        options={[{ value: '', label: t('pinChoose') }, ...open.map((item) => ({ value: item.slug, label: item.title }))]}
      />
      <Button type="submit" disabled={action.disabled || !chosen}>
        <Copy k="pinReview" />
      </Button>
    </form>
  );
}

const dayOf = (iso: string, language: string) => {
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'full' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
};
const timeOf = (iso: string, language: string) => {
  try {
    return new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
};

/** The room's calendar: what is live and what is scheduled, by day in the reader's own time, earliest first. */
export function RoomCalendar({ sessions }: { sessions: readonly CalendarSession[] }) {
  const { Copy } = copy.useCopy();
  const { language } = usePreferences();
  const upcoming = sessions
    .filter((s) => s.status === 'scheduled' || s.status === 'live')
    .slice()
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const days: Array<{ day: string; sessions: CalendarSession[] }> = [];
  for (const s of upcoming) {
    const day = dayOf(s.startsAt, language);
    const last = days[days.length - 1];
    if (last && last.day === day) last.sessions.push(s);
    else days.push({ day, sessions: [s] });
  }
  return (
    <section data-room-calendar aria-label={copy.t('calendarTitle')}>
      <h3>
        <Copy k="calendarTitle" />
      </h3>
      {days.length === 0 ? (
        <p data-room-calendar-empty>
          <Copy k="calendarEmpty" />
        </p>
      ) : (
        days.map((d) => (
          <div key={d.day} data-room-calendar-day={d.day}>
            <h4>{d.day}</h4>
            <ul>
              {d.sessions.map((s) => (
                <li key={s.id} data-room-calendar-session={s.id} data-status={s.status}>
                  <time dateTime={s.startsAt}>{timeOf(s.startsAt, language)}</time> · <span>{s.title}</span> ·{' '}
                  <Copy k={s.status === 'live' ? 'calendarLive' : 'calendarScheduled'} />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

export const ROOM_KINDS = ['general', 'futures', 'options', 'meme_war_room', 'forex', 'defi_lab', 'merchant_clinic'] as const;

/** Narrow the room list to one specialist kind (futures, merchant clinic, ...); blank shows every kind. */
export function RoomKindFilter({ value, onChange }: { value: string; onChange: (kind: string) => void }) {
  const { t } = copy.useCopy();
  return <Select label={t('kindFilter')} value={value} onChange={onChange} options={[{ value: '', label: t('kindAll') }, ...ROOM_KINDS]} />;
}
