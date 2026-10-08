import { t as copyText, Text } from './copy';
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
      <Tabs
        items={['Learning', 'Certificates', 'Rooms', 'Videos', 'Programmes']}
        labels={{
          Learning: copyText('academy.learning'),
          Certificates: copyText('academy.certificates'),
          Rooms: copyText('academy.rooms'),
          Videos: copyText('academy.videos'),
          Programmes: copyText('academy.programmes'),
        }}
        value={tab}
        onChange={setTab}
        label={copyText('academy.academy.sections')}
      />
      {tab === 'Learning' ? (
        slug ? (
          <Panel title={copyText('academy.learning.item')}>
            <Read resource={reader.resource} retry={reader.reload}>
              {(lesson) =>
                lesson ? (
                  <>
                    <h2>{lesson.title}</h2>
                    <p className="muted">
                      {lesson.kind} · {lesson.path} · {lesson.estimatedMinutes}
                      <Text k="academy.minutes" />
                    </p>
                    {lesson.fellBack && (
                      <p className="muted">
                        <Text k="academy.this.lesson.is.available.in" />
                        {lesson.locale}
                        <Text k="academy.your.requested.translation.is.unavailable" />
                      </p>
                    )}
                    <h3>
                      <Text k="academy.learning.objectives" />
                    </h3>
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
                    <h3>
                      <Text k="academy.key.terms" />
                    </h3>
                    <Details items={lesson.keyTerms.map((t) => [t.term, t.definition])} />
                    <h3>
                      <Text k="academy.check.your.understanding" />
                    </h3>
                    <ul>
                      {lesson.selfCheck.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                    <Button
                      disabled={action.disabled}
                      onClick={() =>
                        action.stage({
                          title: copyText('academy.review.lesson.completion'),
                          confirm: copyText('academy.mark.complete'),
                          success: copyText('academy.lesson.completion.recorded'),
                          content: (
                            <p>
                              <Text k="academy.record" />
                              {lesson.title}
                              <Text k="academy.as.completed.for.this.account.this.records" />
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
                      <Text k="academy.review.lesson.completion" />
                    </Button>
                    <a className="text-link" href={`/academy?path=${lesson.path}`}>
                      <Text k="academy.back.to" />
                      {lesson.path}
                    </a>
                    {lesson.kind === 'workbook' && <Workbook slug={lesson.slug} />}
                  </>
                ) : null
              }
            </Read>
          </Panel>
        ) : (
          <Panel title={copyText('academy.learning.library')}>
            <div className="more-inline">
              <Select
                label={copyText('academy.learning.path')}
                value={path}
                onChange={setPath}
                options={['all', 'foundations', 'markets', 'builder', 'sovereign']}
              />
              <Select
                label={copyText('academy.content.kind')}
                value={kind}
                onChange={setKind}
                options={['all', 'playbook', 'workbook', 'lesson']}
              />
            </div>
            <Read resource={list.resource} retry={list.reload} empty={copyText('academy.no.curriculum.items.match.this.path')}>
              {(rows) => (
                <>
                  <div className="more-rooms">
                    {rows.map((r) => (
                      <a className="more-room-link" key={r.slug} href={`/academy/${encodeURIComponent(r.slug)}?path=${r.path}`}>
                        <small>
                          {r.kind} · {r.estimatedMinutes}
                          <Text k="academy.min" />
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
      <Panel title={copyText('academy.certificate.paths')}>
        <Select
          label={copyText('academy.path.to.enrol.in')}
          value={enrolPath}
          onChange={setEnrolPath}
          options={['foundations', 'markets', 'builder', 'sovereign']}
        />
        <Button
          disabled={action.disabled}
          onClick={() =>
            action.stage({
              title: copyText('academy.review.path.enrolment'),
              confirm: copyText('academy.enrol.in.path'),
              success: copyText('academy.enrolment.recorded'),
              content: (
                <p>
                  <Text k="academy.enrol.in" />
                  {enrolPath}
                  <Text k="academy.for.this.account" />
                </p>
              ),
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
          <Text k="academy.review.enrolment" />
        </Button>
        <Read resource={definitions.resource} retry={definitions.reload} empty={copyText('academy.no.certificate.paths.are.published')}>
          {(rows) => (
            <div className="more-grid">
              {rows.map((c) => (
                <article key={c.id}>
                  <h3>{c.title}</h3>
                  <p>
                    {c.requiredItemSlugs.length}
                    <Text k="academy.required.learning.items" />
                  </p>
                  <Button variant="secondary" onClick={() => setSelected(c.id)}>
                    <Text k="academy.open" />
                    {c.title}
                  </Button>
                </article>
              ))}
            </div>
          )}
        </Read>
      </Panel>
      <Panel title={copyText('academy.your.progress')}>
        <Read resource={detail.resource} retry={detail.reload} empty={copyText('academy.choose.a.certificate.path')}>
          {(p) =>
            p ? (
              <>
                <h2>{p.title}</h2>
                <Details
                  items={[
                    [
                      copyText('academy.completed'),
                      copyText('common.progress.count', { completed: p.completedCount, required: p.requiredCount }),
                    ],
                    [copyText('academy.ratio'), p.ratio],
                    [copyText('academy.granted'), copyText(p.granted ? 'common.yes' : 'common.no')],
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
                      title: copyText('academy.review.certification.grant'),
                      confirm: p.granted ? copyText('academy.recover.certification.award') : copyText('academy.request.certification'),
                      success: copyText('academy.certification.outcome.received.xp.delivery.is.shown'),
                      content: (
                        <p>
                          <Text k="academy.the.service.checks.completed.items.and.issues" />
                        </p>
                      ),
                      run: () =>
                        api.mutate(
                          'academy',
                          'grantCert',
                          { certId: p.certId },
                          grantReceipt.refine(
                            (r) => r.grant.userId === userId && r.grant.certId === p.certId,
                            copyText('academy.certification.does.not.match.this.account.and'),
                          ),
                        ),
                      done: detail.reload,
                    })
                  }
                >
                  {p.granted ? copyText('academy.recover.certification.award') : copyText('academy.request.certification')}
                </Button>
              </>
            ) : null
          }
        </Read>
        {receipt?.success && (
          <section aria-label={copyText('academy.certification.receipt')}>
            <h3>
              <Text k="academy.certification.receipt" />
            </h3>
            <Details
              items={[
                [copyText('academy.certification'), receipt.data.grant.certId],
                [copyText('academy.granted'), receipt.data.grant.grantedAt],
                [copyText('academy.already.granted'), copyText(receipt.data.alreadyGranted ? 'common.yes' : 'common.no')],
                [
                  copyText('academy.xp.delivery'),
                  receipt.data.xp.emitted
                    ? copyText('academy.xp.emitted', { xp: receipt.data.xp.xpDelta })
                    : copyText('academy.not.emitted', { reason: receipt.data.xp.reason }),
                ],
                [
                  copyText('academy.perks'),
                  receipt.data.perks.status === 'real'
                    ? copyText('academy.authoritative.identity.rank.perks.returned.academy.holds')
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
      <Panel title={copyText('academy.video.library')}>
        <Read resource={list.resource} retry={list.reload} empty={copyText('academy.no.videos.are.available')}>
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
      <Panel title={copyText('academy.playback')}>
        <Read resource={playback.resource} retry={playback.reload} empty={copyText('academy.choose.a.video')}>
          {(p) =>
            p ? (
              Date.parse(p.expiresAt) > Date.now() && p.playbackUrl.startsWith('https:') ? (
                <>
                  <video controls style={{ width: '100%' }} src={p.playbackUrl} />
                  <p className="muted">
                    <Text k="academy.playback.grant.expires" />
                    {p.expiresAt}.
                  </p>
                </>
              ) : (
                <p>
                  <Text k="academy.the.playback.grant.is.expired.or.cannot" />
                </p>
              )
            ) : null
          }
        </Read>
      </Panel>
    </div>
  );
}
