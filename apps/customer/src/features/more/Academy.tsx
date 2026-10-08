import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Panel, Tabs } from '../../shared/ui';
import { Details, Limit, Read, Select, useAction } from './common';
import { AcademyRooms } from './AcademyRooms';
import { AcademyProgrammes } from './AcademyProgrammes';
import { Workbook } from './Workbook';
const summary = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.enum(['playbook', 'workbook', 'lesson']),
  path: z.enum(['foundations', 'markets', 'builder', 'sovereign']),
  order: z.number().int(),
  summary: z.string(),
  estimatedMinutes: z.number().int().positive(),
});
const item = summary.extend({
  body: z.string(),
  objectives: z.array(z.string()),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })),
  selfCheck: z.array(z.string()),
  locale: z.string(),
  fellBack: z.boolean(),
  i18nStrategy: z.string(),
});
const uuid = z.string().uuid();
export function Academy({ slug, initialPath }: { slug?: string; initialPath?: string }) {
  const api = useApi(),
    { userId } = useSession(),
    preferences = usePreferences(),
    action = useAction('academy');
  const [tab, setTab] = useState('Learning'),
    [path, setPath] = useState(['foundations', 'markets', 'builder', 'sovereign'].includes(initialPath ?? '') ? initialPath! : 'all'),
    [kind, setKind] = useState('all'),
    [limit, setLimit] = useState(50);
  const list = useResource(
    (signal) =>
      api.query(
        'academy',
        'curriculum',
        { limit, ...(path !== 'all' ? { path } : {}), ...(kind !== 'all' ? { kind } : {}) },
        z.array(summary),
        { signal },
      ),
    `curriculum:${userId}:${path}:${kind}:${limit}`,
  );
  const reader = useResource(
    (signal) =>
      slug
        ? api.query('academy', 'curriculumItemLocalized', { slug, locale: preferences.language }, item, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `reader:${userId}:${slug}:${preferences.language}`,
  );
  return (
    <div className="more-grid">
      <Tabs items={['Learning', 'Certificates', 'Rooms', 'Videos', 'Programmes']} value={tab} onChange={setTab} label="Academy sections" />
      {tab === 'Learning' ? (
        slug ? (
          <Panel title="Learning item">
            <Read resource={reader.resource} retry={reader.reload}>
              {(lesson) =>
                lesson ? (
                  <>
                    <h2>{lesson.title}</h2>
                    <p className="muted">
                      {lesson.kind} · {lesson.path} · {lesson.estimatedMinutes} minutes
                    </p>
                    {lesson.fellBack && (
                      <p className="muted">This lesson is available in {lesson.locale}; your requested translation is unavailable.</p>
                    )}
                    <h3>Learning objectives</h3>
                    <ul>
                      {lesson.objectives.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                    <article className="more-body">
                      {lesson.body
                        .split('\n')
                        .map((line, i) => (/^#{1,3} /.test(line) ? <h3 key={i}>{line.replace(/^#+ /, '')}</h3> : <p key={i}>{line}</p>))}
                    </article>
                    <h3>Key terms</h3>
                    <Details items={lesson.keyTerms.map((t) => [t.term, t.definition])} />
                    <h3>Check your understanding</h3>
                    <ul>
                      {lesson.selfCheck.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                    <Button
                      disabled={action.disabled}
                      onClick={() =>
                        action.stage({
                          title: 'Review lesson completion',
                          confirm: 'Mark complete',
                          success: 'Lesson completion recorded',
                          content: (
                            <p>
                              Record {lesson.title} as completed for this account. This records progress; certification and XP are separate
                              service outcomes.
                            </p>
                          ),
                          run: () =>
                            api.mutate(
                              'academy',
                              'markCurriculumComplete',
                              { itemSlug: lesson.slug },
                              z.object({ userId: uuid, itemSlug: z.string(), completedAt: z.string() }),
                            ),
                        })
                      }
                    >
                      Review lesson completion
                    </Button>
                    <a className="text-link" href={`/academy?path=${lesson.path}`}>
                      Back to {lesson.path}
                    </a>
                    {lesson.kind === 'workbook' && <Workbook slug={lesson.slug} />}
                  </>
                ) : null
              }
            </Read>
          </Panel>
        ) : (
          <Panel title="Learning library">
            <div className="more-inline">
              <Select
                label="Learning path"
                value={path}
                onChange={setPath}
                options={['all', 'foundations', 'markets', 'builder', 'sovereign']}
              />
              <Select label="Content kind" value={kind} onChange={setKind} options={['all', 'playbook', 'workbook', 'lesson']} />
            </div>
            <Read resource={list.resource} retry={list.reload} empty="No curriculum items match this path">
              {(rows) => (
                <>
                  <div className="more-rooms">
                    {rows.map((r) => (
                      <a className="more-room-link" key={r.slug} href={`/academy/${encodeURIComponent(r.slug)}?path=${r.path}`}>
                        <small>
                          {r.kind} · {r.estimatedMinutes} min
                        </small>
                        <strong>{r.title}</strong>
                        <p>{r.summary}</p>
                      </a>
                    ))}
                  </div>
                  <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
                </>
              )}
            </Read>
          </Panel>
        )
      ) : tab === 'Certificates' ? (
        <Certificates action={action} />
      ) : tab === 'Rooms' ? (
        <AcademyRooms action={action} />
      ) : tab === 'Videos' ? (
        <Videos />
      ) : (
        <AcademyProgrammes action={action} />
      )}{' '}
      {action.feedback}
      {action.dialog}
    </div>
  );
}
const cert = z.object({ id: z.string(), title: z.string(), requiredItemSlugs: z.array(z.string()) });
const progress = z.object({
  userId: uuid,
  certId: z.string(),
  title: z.string(),
  requiredCount: z.number().int(),
  completedCount: z.number().int(),
  ratio: z.string(),
  missingItemSlugs: z.array(z.string()),
  complete: z.boolean(),
  granted: z.boolean(),
  grantIdempotencyKey: z.string().nullable(),
});
const grantReceipt = z.object({
  grant: z.object({ userId: uuid, certId: z.string(), grantedAt: z.string(), idempotencyKey: z.string() }),
  alreadyGranted: z.boolean(),
  xp: z.discriminatedUnion('emitted', [
    z.object({ emitted: z.literal(true), idempotencyKey: z.string(), xpDelta: z.number().int() }),
    z.object({ emitted: z.literal(false), reason: z.string() }),
  ]),
  perks: z.discriminatedUnion('status', [
    z.object({ status: z.literal('real'), sot: z.literal('svc-identity'), academyHoldsPerkMoney: z.literal(false) }),
    z.object({ status: z.literal('refuse'), message: z.string(), code: z.string() }),
  ]),
});
function Certificates({ action }: { action: ReturnType<typeof useAction> }) {
  const api = useApi(),
    { userId } = useSession();
  const [selected, setSelected] = useState(''),
    [enrolPath, setEnrolPath] = useState('foundations');
  const receipt = action.result?.ok ? grantReceipt.safeParse(action.result.data) : null;
  const definitions = useResource(
      (signal) => api.query('academy', 'certDefinitions', undefined, z.array(cert), { signal }),
      `cert-defs:${userId}`,
    ),
    detail = useResource(
      (signal) =>
        selected
          ? api.query('academy', 'certProgress', { certId: selected }, progress, { signal })
          : Promise.resolve({ ok: true as const, data: null }),
      `cert-progress:${userId}:${selected}`,
    );
  return (
    <div className="more-columns">
      <Panel title="Certificate paths">
        <Select
          label="Path to enrol in"
          value={enrolPath}
          onChange={setEnrolPath}
          options={['foundations', 'markets', 'builder', 'sovereign']}
        />
        <Button
          disabled={action.disabled}
          onClick={() =>
            action.stage({
              title: 'Review path enrolment',
              confirm: 'Enrol in path',
              success: 'Enrolment recorded',
              content: <p>Enrol in {enrolPath} for this account.</p>,
              run: () =>
                api.mutate(
                  'academy',
                  'enrollCertPath',
                  { pathSlug: enrolPath },
                  z.object({ userId: uuid, pathSlug: z.string(), enrolledAt: z.string() }),
                ),
              done: detail.reload,
            })
          }
        >
          Review enrolment
        </Button>
        <Read resource={definitions.resource} retry={definitions.reload} empty="No certificate paths are published">
          {(rows) => (
            <div className="more-grid">
              {rows.map((c) => (
                <article key={c.id}>
                  <h3>{c.title}</h3>
                  <p>{c.requiredItemSlugs.length} required learning items</p>
                  <Button variant="secondary" onClick={() => setSelected(c.id)}>
                    Open {c.title}
                  </Button>
                </article>
              ))}
            </div>
          )}
        </Read>
      </Panel>
      <Panel title="Your progress">
        <Read resource={detail.resource} retry={detail.reload} empty="Choose a certificate path">
          {(p) =>
            p ? (
              <>
                <h2>{p.title}</h2>
                <Details
                  items={[
                    ['Completed', `${p.completedCount} of ${p.requiredCount}`],
                    ['Ratio', p.ratio],
                    ['Granted', p.granted ? 'Yes' : 'No'],
                  ]}
                />
                <ul>
                  {p.missingItemSlugs.map((s) => (
                    <li key={s}>
                      <a className="text-link" href={`/academy/${encodeURIComponent(s)}`}>
                        {s}
                      </a>
                    </li>
                  ))}
                </ul>
                <Button
                  disabled={action.disabled || !p.complete}
                  onClick={() =>
                    action.stage({
                      title: 'Review certification grant',
                      confirm: p.granted ? 'Recover certification award' : 'Request certification',
                      success: 'Certification outcome received; XP delivery is shown separately',
                      content: (
                        <p>
                          The service checks completed items and issues an idempotent certification. XP depends on the identity publisher
                          and its policy.
                        </p>
                      ),
                      run: () =>
                        api.mutate(
                          'academy',
                          'grantCert',
                          { certId: p.certId },
                          grantReceipt.refine(
                            (r) => r.grant.userId === userId && r.grant.certId === p.certId,
                            'Certification does not match this account and path',
                          ),
                        ),
                      done: detail.reload,
                    })
                  }
                >
                  {p.granted ? 'Recover certification award' : 'Request certification'}
                </Button>
              </>
            ) : null
          }
        </Read>
        {receipt?.success && (
          <section aria-label="Certification receipt">
            <h3>Certification receipt</h3>
            <Details
              items={[
                ['Certification', receipt.data.grant.certId],
                ['Granted', receipt.data.grant.grantedAt],
                ['Already granted', receipt.data.alreadyGranted ? 'Yes' : 'No'],
                [
                  'XP delivery',
                  receipt.data.xp.emitted ? `${receipt.data.xp.xpDelta} XP emitted` : `Not emitted: ${receipt.data.xp.reason}`,
                ],
                [
                  'Perks',
                  receipt.data.perks.status === 'real'
                    ? 'Authoritative identity-rank perks returned; Academy holds no perk money'
                    : receipt.data.perks.message,
                ],
              ]}
            />
          </section>
        )}
      </Panel>
    </div>
  );
}
function Videos() {
  const api = useApi(),
    { userId } = useSession();
  const [selected, setSelected] = useState('');
  const list = useResource(
      (signal) =>
        api.query('academy', 'videos', undefined, z.array(z.object({ slug: z.string(), title: z.string(), path: z.string() })), { signal }),
      `videos:${userId}`,
    ),
    playback = useResource(
      (signal) =>
        selected
          ? api.query(
              'academy',
              'videoPlayback',
              { slug: selected },
              z.object({ slug: z.string(), playbackUrl: z.string().url(), expiresAt: z.string(), grant: z.string() }),
              { signal },
            )
          : Promise.resolve({ ok: true as const, data: null }),
      `video:${userId}:${selected}`,
    );
  return (
    <div className="more-columns">
      <Panel title="Video library">
        <Read resource={list.resource} retry={list.reload} empty="No videos are available">
          {(rows) => (
            <ul>
              {rows.map((v) => (
                <li key={v.slug}>
                  <Button variant="ghost" onClick={() => setSelected(v.slug)}>
                    {v.title}
                  </Button>{' '}
                  · {v.path}
                </li>
              ))}
            </ul>
          )}
        </Read>
      </Panel>
      <Panel title="Playback">
        <Read resource={playback.resource} retry={playback.reload} empty="Choose a video">
          {(p) =>
            p ? (
              Date.parse(p.expiresAt) > Date.now() && p.playbackUrl.startsWith('https:') ? (
                <>
                  <video controls style={{ width: '100%' }} src={p.playbackUrl} />
                  <p className="muted">Playback grant expires {p.expiresAt}.</p>
                </>
              ) : (
                <p>The playback grant is expired or cannot be verified as a secure URL.</p>
              )
            ) : null
          }
        </Read>
      </Panel>
    </div>
  );
}
