import { useState } from 'react';
import { Award, Check, Circle, Radio } from 'lucide-react';
import { StatusTag, Tabs, TabsList, TabsPanel, TabsTab, ToggleGroup, ToggleGroupItem, StateBlock, type StatusKind } from '@intafaced/ui';
import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewChip, PreviewScreen } from '../../../preview';
import {
  academyFixture,
  type AcademyCert,
  type AcademyCourse,
  type AcademyLobby,
  type CertStatus,
} from '../../../preview/fixtures/academy';
import './academy.css';
import { academyCopy } from './copy';
import { barPct } from './format';

const { courses, lobbies, certs, topics, continueCourseId } = academyFixture.rows;
const lessonsTotal = courses.reduce((sum, course) => sum + course.lessons, 0);
const lessonsDone = courses.reduce((sum, course) => sum + course.lessonsDone, 0);
const coursesDone = courses.filter((course) => course.lessonsDone === course.lessons).length;
const continueCourse = courses.find((course) => course.id === continueCourseId) ?? courses[0]!;

function CourseCard({ course }: { course: AcademyCourse }) {
  const { t } = academyCopy.useCopy();
  const finished = course.lessonsDone === course.lessons;
  const started = course.lessonsDone > 0;
  return (
    <li className="pv-acad__course" data-testid="academy-course" data-done={finished}>
      <div className="pv-acad__course-top">
        <span className="pv-acad__tag">{course.level}</span>
        <span className="pv-acad__label">{course.topic}</span>
      </div>
      <h3 className="pv-acad__h3">{course.title}</h3>
      <p className="pv-acad__label">{course.summary}</p>
      <p className="pv-acad__label">
        {t('Lesson count', { count: course.lessons })} · {t('Minutes', { count: course.minutes })}
      </p>
      <div className="pv-acad__bar" role="img" aria-label={t('Lessons progress', { done: course.lessonsDone, total: course.lessons })}>
        <span style={{ width: `${barPct(String(course.lessonsDone), String(course.lessons))}%` }} />
      </div>
      <div className="pv-acad__course-foot">
        <span className="pv-acad__label">
          {finished
            ? t('Course done')
            : started
              ? t('Lessons progress', { done: course.lessonsDone, total: course.lessons })
              : t('Not started')}
        </span>
        <PreviewActionButton product="academy" variant={finished ? 'secondary' : started ? 'primary' : 'secondary'} size={32}>
          {finished ? t('Review') : started ? t('Continue course') : t('Start course')}
        </PreviewActionButton>
      </div>
    </li>
  );
}

function Lobby({ lobby }: { lobby: AcademyLobby }) {
  const { t } = academyCopy.useCopy();
  const live = lobby.state === 'live';
  return (
    <li className="pv-acad__lobby" data-testid="academy-lobby" data-live={live}>
      <div className="pv-acad__lobby-top">
        <span className={live ? 'pv-acad__live' : 'pv-acad__tag'}>
          {live ? <Radio size={12} strokeWidth={2} aria-hidden="true" /> : null}
          {live ? t('Live now tag') : lobby.timing}
        </span>
        <span className="pv-acad__label">
          {lobby.topic} · {t('Lobby length', { count: lobby.minutes })}
        </span>
      </div>
      <h3 className="pv-acad__h3">{lobby.title}</h3>
      <p className="pv-acad__label">{t('Hosted by', { host: lobby.host, role: lobby.hostRole })}</p>
      <div className="pv-acad__seats" role="img" aria-label={t('Seats taken', { taken: lobby.taken, seats: lobby.seats })}>
        {Array.from({ length: lobby.seats }, (_, index) => (
          <span key={index} data-taken={index < lobby.taken} />
        ))}
      </div>
      <div className="pv-acad__course-foot">
        <span className="pv-acad__label">{t('Seats taken', { taken: lobby.taken, seats: lobby.seats })}</span>
        <PreviewActionButton product="academy" variant={live ? 'primary' : 'secondary'} size={32}>
          {live ? t('Join lobby') : t('Save seat')}
        </PreviewActionButton>
      </div>
    </li>
  );
}

const certStatus: Record<CertStatus, StatusKind> = { earned: 'filled', 'in-progress': 'working', locked: 'working' };

function Cert({ cert }: { cert: AcademyCert }) {
  const { t } = academyCopy.useCopy();
  const label: Record<CertStatus, string> = { earned: t('Earned'), 'in-progress': t('Cert in progress'), locked: t('Locked') };
  return (
    <li className="pv-acad__cert" data-testid="academy-cert" data-status={cert.status}>
      <div className="pv-acad__cert-head">
        <span className="pv-acad__badge" aria-hidden="true" title={t('Badge slot')}>
          <Award size={22} strokeWidth={1.5} />
        </span>
        <StatusTag status={certStatus[cert.status]} label={label[cert.status]} />
      </div>
      <h3 className="pv-acad__h3">{cert.title}</h3>
      <p className="pv-acad__label">{cert.summary}</p>
      <h4 className="pv-acad__h4">{t('What you need')}</h4>
      <ul className="pv-acad__reqs">
        {cert.requirements.map((req) => (
          <li key={req.label} data-done={req.done}>
            {req.done ? (
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
            ) : (
              <Circle size={10} strokeWidth={2.5} aria-hidden="true" />
            )}
            <span>{req.label}</span>
          </li>
        ))}
      </ul>
      <p className="pv-acad__label">
        {t('Unlocks')}: {cert.unlocks}
      </p>
      <PreviewActionButton
        product="academy"
        variant={cert.status === 'earned' ? 'secondary' : 'primary'}
        size={32}
        disabled={cert.status === 'locked'}
      >
        {cert.status === 'earned' ? t('View certificate') : t('Start certificate')}
      </PreviewActionButton>
    </li>
  );
}

/** Academy Preview: courses and progress, live lobbies, and certificates. Sample data only. */
export default function AcademyPreview(_props: ScreenProps) {
  const { t } = academyCopy.useCopy();
  const [tab, setTab] = useState('courses');
  const [topic, setTopic] = useState('all');
  const shown = topic === 'all' ? courses : courses.filter((course) => course.topic === topic);

  return (
    <PreviewScreen product="academy">
      <div className="pv-acad">
        <section className="pv-acad__summary" aria-labelledby="pv-acad-progress" data-testid="academy-progress">
          <div>
            <h2 id="pv-acad-progress" className="pv-acad__h2">
              {t('Progress title')} <PreviewChip />
            </h2>
            <p className="pv-acad__big">{t('Courses done', { done: coursesDone, total: courses.length })}</p>
            <div className="pv-acad__bar" role="img" aria-label={t('Lessons done', { done: lessonsDone, total: lessonsTotal })}>
              <span style={{ width: `${barPct(String(lessonsDone), String(lessonsTotal))}%` }} />
            </div>
            <p className="pv-acad__label">{t('Lessons done', { done: lessonsDone, total: lessonsTotal })}</p>
          </div>
          <div className="pv-acad__continue">
            <span className="pv-acad__label">{t('Continue')}</span>
            <span className="pv-acad__strong">{continueCourse.title}</span>
            <span className="pv-acad__label">
              {t('Lessons progress', { done: continueCourse.lessonsDone, total: continueCourse.lessons })}
            </span>
            <PreviewActionButton product="academy" variant="primary" size={40}>
              {t('Continue button')}
            </PreviewActionButton>
          </div>
        </section>

        <Tabs value={tab} onValueChange={(next) => setTab(String(next))}>
          <TabsList divider className="pv-acad__tabs">
            <TabsTab value="courses">{t('Tab courses')}</TabsTab>
            <TabsTab value="lobbies">{t('Tab lobbies')}</TabsTab>
            <TabsTab value="certs">{t('Tab certs')}</TabsTab>
          </TabsList>

          <TabsPanel value="courses">
            <section className="pv-acad__panel" aria-labelledby="pv-acad-courses">
              <div className="pv-acad__head">
                <h2 id="pv-acad-courses" className="pv-acad__h2">
                  {t('Courses title')} <PreviewChip />
                </h2>
                <ToggleGroup aria-label={t('Topic filter')} value={topic} onValueChange={setTopic}>
                  <ToggleGroupItem value="all">{t('All topics')}</ToggleGroupItem>
                  {topics.map((name) => (
                    <ToggleGroupItem key={name} value={name}>
                      {name}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              {shown.length === 0 ? (
                <StateBlock kind="empty" title={t('Empty courses')} />
              ) : (
                <ul className="pv-acad__grid">
                  {shown.map((course) => (
                    <CourseCard key={course.id} course={course} />
                  ))}
                </ul>
              )}
            </section>
          </TabsPanel>

          <TabsPanel value="lobbies">
            <section className="pv-acad__panel" aria-labelledby="pv-acad-lobbies">
              <h2 id="pv-acad-lobbies" className="pv-acad__h2">
                {t('Lobbies title')} <PreviewChip />
              </h2>
              <p className="pv-acad__label pv-acad__lede">{t('Lobbies lede')}</p>
              <ul className="pv-acad__grid">
                {lobbies.map((lobby) => (
                  <Lobby key={lobby.id} lobby={lobby} />
                ))}
              </ul>
            </section>
          </TabsPanel>

          <TabsPanel value="certs">
            <section className="pv-acad__panel" aria-labelledby="pv-acad-certs">
              <h2 id="pv-acad-certs" className="pv-acad__h2">
                {t('Certs title')} <PreviewChip />
              </h2>
              <p className="pv-acad__label pv-acad__lede">{t('Certs lede')}</p>
              <ul className="pv-acad__grid">
                {certs.map((cert) => (
                  <Cert key={cert.id} cert={cert} />
                ))}
              </ul>
            </section>
          </TabsPanel>
        </Tabs>
      </div>
    </PreviewScreen>
  );
}
