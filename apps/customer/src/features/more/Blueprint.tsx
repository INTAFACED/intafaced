import { t as copyText, Text } from './copy';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Field, Panel } from '../../shared/ui';
import { Details, Read, Select, useAction } from './common';
import { BlueprintSharedCard, BlueprintMentorCardAction } from './BlueprintSharedCard';
import { BlueprintCrew } from './BlueprintCrew';
import { blueprintSessionCopy } from './blueprint-session-copy';

const VISIBILITIES = ['private', 'crew', 'public'] as const;
const CARD_SIZES = ['portrait', 'landscape'] as const;
const uuid = z.string().guid();
const profile = z.object({
  decisionStyle: z.enum(['analytical', 'intuitive', 'collaborative', 'decisive']),
  riskTemperament: z.enum(['guarded', 'measured', 'assertive', 'bold']),
  energyRhythm: z.enum(['dawn', 'steady', 'surge', 'nocturnal']),
  learningMode: z.enum(['visual', 'narrative', 'hands_on', 'systematic']),
  crewRole: z.enum(['anchor', 'scout', 'builder', 'catalyst']),
  curriculumPath: z.enum(['foundations', 'markets', 'builder', 'sovereign']),
  toneRegister: z.enum(['direct', 'warm', 'socratic', 'terse']),
  guardrails: z.object({
    maxLeverage: z.number().int(),
    dailyLossPromptPct: z.number().int(),
    confirmBeforeMarketOrder: z.boolean(),
    copyTradingVisible: z.boolean(),
  }),
});
const blueprint = z.object({
  id: uuid,
  userId: uuid,
  engineVersion: z.string(),
  profile,
  cardAssetUrl: z.string().nullable(),
  visibility: z.enum(['private', 'crew', 'public']),
  createdAt: z.string(),
});
const mentor = z.object({
  studentId: uuid,
  mentorId: uuid,
  fitScore: z.number().int().min(0).max(10000),
  status: z.enum(['shortlisted', 'accepted', 'declined', 'ended']),
});
const card = z.object({
  size: z.enum(['portrait', 'landscape']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  svg: z.string().min(1),
  shareMode: z.enum(['svg', 'png']),
  raster: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('rendered'),
      url: z.string().url(),
      contentType: z.literal('image/png'),
      bytes: z.number().int().positive(),
    }),
    z.object({ status: z.literal('unavailable'), code: z.string(), reason: z.string() }),
  ]),
});
export function safeCardSvg(svg: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return false;
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') return false;
  const allowed = new Set([
    'svg',
    'g',
    'defs',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'path',
    'text',
    'tspan',
    'linearGradient',
    'radialGradient',
    'stop',
    'pattern',
    'clipPath',
    'mask',
    'title',
    'desc',
  ]);
  for (const element of [document.documentElement, ...document.documentElement.querySelectorAll('*')]) {
    if (!allowed.has(element.localName) || element.namespaceURI !== 'http://www.w3.org/2000/svg') return false;
    for (const attr of element.attributes) {
      if (/^on/i.test(attr.localName) || ['href', 'src', 'base'].includes(attr.localName)) return false;
      if (attr.name === 'xmlns' || attr.name === 'xmlns:xlink') continue;
      const remainder = attr.value.replace(/url\(\s*#[a-zA-Z_][a-zA-Z0-9_-]*\s*\)/g, '');
      if (/url\s*\(|javascript:|data:|https?:|@import|expression\s*\(/i.test(remainder)) return false;
    }
  }
  return true;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Blueprint({ path = '/blueprint' }: { path?: string }) {
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('blueprint'),
    { t: label } = blueprintSessionCopy.useCopy();
  const [size, setSize] = useState('portrait'),
    [erase, setErase] = useState(''),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState('');
  const me = useResource(
      (signal) =>
        api.query(
          'blueprint',
          'me',
          undefined,
          blueprint
            .nullable()
            .refine((row) => !row || row.userId === userId, copyText('blueprint.blueprint.ownership.does.not.match.this.account')),
          { signal },
        ),
      `blueprint:${userId}`,
    ),
    mentors = useResource(
      (signal) =>
        api.query(
          'blueprint',
          'mentors',
          undefined,
          z
            .array(mentor)
            .refine(
              (rows) => rows.every((row) => row.studentId === userId),
              copyText('blueprint.mentor.shortlist.belongs.to.another.account'),
            ),
          { signal },
        ),
      `mentors:${userId}`,
    ),
    share = useResource((signal) => api.query('blueprint', 'card', { size }, card, { signal }), `card:${userId}:${size}`);
  const currentMentors = useRef(mentors.resource);
  currentMentors.current = mentors.resource;
  const reload = () => {
    me.reload();
    mentors.reload();
    share.reload();
  };
  return (
    <div className="more-columns">
      <div>
        <BlueprintCrew />
        <BlueprintSharedCard path={path} />
        <Panel title={copyText('blueprint.identity.blueprint')}>
          <Read resource={me.resource} retry={me.reload} empty={copyText('blueprint.your.blueprint.has.not.been.created')}>
            {(record) =>
              record ? (
                <>
                  <Details
                    items={[
                      [copyText('blueprint.decision.style'), record.profile.decisionStyle],
                      [copyText('blueprint.risk.temperament'), record.profile.riskTemperament],
                      [copyText('blueprint.energy.rhythm'), record.profile.energyRhythm],
                      [copyText('blueprint.learning.mode'), record.profile.learningMode],
                      [copyText('blueprint.crew.role'), record.profile.crewRole],
                      [copyText('blueprint.visibility'), label(record.visibility)],
                      [copyText('blueprint.engine.build'), record.engineVersion],
                    ]}
                  />
                  <a className="text-link" href={`/academy?path=${encodeURIComponent(record.profile.curriculumPath)}`}>
                    <Text k="blueprint.open.your" />
                    {record.profile.curriculumPath}
                    <Text k="blueprint.learning.path" />
                  </a>
                  <Select
                    label={copyText('blueprint.blueprint.visibility')}
                    value={record.visibility}
                    onChange={(value) =>
                      action.stage({
                        title: copyText('blueprint.review.visibility.change'),
                        confirm: copyText('blueprint.change.visibility'),
                        success: copyText('blueprint.visibility.updated'),
                        content: (
                          <p>
                            {value === 'private'
                              ? copyText('blueprint.only.you.can.view.your.share.card')
                              : value === 'crew'
                                ? copyText('blueprint.signed.crew.members.can.view.your.share')
                                : copyText('blueprint.any.signed.in.account.can.view.your')}
                          </p>
                        ),
                        run: () => api.mutate('blueprint', 'setVisibility', { visibility: value }, blueprint),
                        done: reload,
                      })
                    }
                    options={VISIBILITIES.map((value) => ({ value, label: label(value) }))}
                  />
                </>
              ) : null
            }
          </Read>
        </Panel>
        <Panel title={copyText('blueprint.share.card')}>
          <Select
            label={copyText('blueprint.card.size')}
            value={size}
            onChange={setSize}
            options={CARD_SIZES.map((value) => ({ value, label: label(value) }))}
          />
          <Read resource={share.resource} retry={share.reload}>
            {(c) => (
              <>
                {safeCardSvg(c.svg) ? (
                  <>
                    <img
                      className="more-card-image"
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.svg)}`}
                      alt={copyText('blueprint.identity.blueprint.card', { value1: c.size })}
                      width={c.width}
                      height={c.height}
                    />
                    <Button variant="secondary" onClick={() => download(`identity-blueprint-${c.size}.svg`, c.svg, 'image/svg+xml')}>
                      <Text k="blueprint.download.svg.card" />
                    </Button>
                  </>
                ) : (
                  <p role="alert">
                    <Text k="blueprint.the.card.contains.unsupported.active.or.external" />
                  </p>
                )}
                {c.raster.status === 'unavailable' ? (
                  <p className="muted">
                    <Text k="blueprint.png.unavailable" />
                    {c.raster.reason}
                  </p>
                ) : c.raster.url.startsWith('https:') ? (
                  <a className="text-link" href={c.raster.url} target="_blank" rel="noreferrer">
                    <Text k="blueprint.open.rendered.png" />
                  </a>
                ) : (
                  <p>
                    <Text k="blueprint.png.url.cannot.be.verified.as.a" />
                  </p>
                )}
                <p className="muted">
                  <Text k="blueprint.share.mode" />
                  {c.shareMode}
                  <Text k="blueprint.card.reads.require.a.signed.viewer.and" />
                </p>
              </>
            )}
          </Read>
        </Panel>
        <Panel title={copyText('blueprint.mentor.shortlist')}>
          <Read resource={mentors.resource} retry={mentors.reload} empty={copyText('blueprint.no.mentors.are.shortlisted')}>
            {(rows) => (
              <ul>
                {rows.map((m) => (
                  <li key={m.mentorId}>
                    <code>{m.mentorId}</code> · {m.fitScore}
                    <Text k="blueprint.basis.points.of.fit" />
                    {label(m.status)}
                    <BlueprintMentorCardAction
                      subject={m.mentorId}
                      available={() =>
                        api.canWrite() &&
                        action.isCurrent() &&
                        currentMentors.current === mentors.resource &&
                        mentors.resource.status === 'ready' &&
                        mentors.resource.data.includes(m) &&
                        m.studentId === userId
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </Read>
          <p className="muted">{label('mentorLimit')}</p>
        </Panel>
        <Panel title={copyText('blueprint.your.data')}>
          <Button
            variant="secondary"
            disabled={exporting || !userId}
            onClick={() => {
              setExporting(true);
              setExportError('');
              void api
                .query(
                  'blueprint',
                  'export',
                  undefined,
                  z.object({
                    schemaVersion: z.literal(2),
                    exportedAt: z.string(),
                    blueprint: blueprint.nullable(),
                    card: card.nullable(),
                    crew: z.unknown(),
                    membership: z.unknown(),
                    crewmates: z.array(z.unknown()),
                    matchRuns: z.array(z.unknown()),
                    mentorMatches: z.array(mentor),
                    mentoringOthers: z.array(mentor),
                  }),
                )
                .then((res) => {
                  setExporting(false);
                  if (res.ok && action.isCurrent())
                    download('identity-blueprint.json', JSON.stringify(res.data, null, 2), 'application/json');
                  else if (!res.ok && action.isCurrent()) setExportError(res.message);
                });
            }}
          >
            <Text k="blueprint.export.blueprint.json" />
          </Button>
          {exportError && <p role="alert">{exportError}</p>}
          <div className="more-danger">
            <h3>
              <Text k="blueprint.erase.your.blueprint" />
            </h3>
            <p>
              <Text k="blueprint.hard.delete.the.profile.crew.membership.match" />
            </p>
            <Field label={copyText('blueprint.type.erase.blueprint')} value={erase} onChange={(e) => setErase(e.target.value)} />
            <Button
              variant="danger"
              disabled={action.disabled || erase !== 'ERASE BLUEPRINT'}
              onClick={() =>
                action.stage({
                  title: copyText('blueprint.permanently.erase.blueprint'),
                  confirm: copyText('blueprint.erase.blueprint.permanently'),
                  success: copyText('blueprint.blueprint.erasure.confirmed'),
                  content: (
                    <p>
                      <Text k="blueprint.this.cannot.be.undone.the.service.returns" />
                    </p>
                  ),
                  run: () =>
                    api.mutate(
                      'blueprint',
                      'erase',
                      undefined,
                      z.object({
                        userId: uuid,
                        erasedAt: z.string(),
                        removed: z.object({
                          blueprints: z.number().int().nonnegative(),
                          crewMemberships: z.number().int().nonnegative(),
                          matchRuns: z.number().int().nonnegative(),
                          mentorMatches: z.number().int().nonnegative(),
                          emptiedCrews: z.number().int().nonnegative(),
                        }),
                      }),
                    ),
                  done: () => {
                    setErase('');
                    reload();
                  },
                })
              }
            >
              <Text k="blueprint.review.permanent.erasure" />
            </Button>
          </div>
        </Panel>
      </div>
      <Panel title={copyText('blueprint.guided.blueprint.session')}>
        <p className="muted" id="blueprint-session-reason">
          {label('unavailable')}
        </p>
        <form onSubmit={(e) => e.preventDefault()} aria-describedby="blueprint-session-reason">
          <fieldset disabled>
            <Select
              label={copyText('blueprint.initial.visibility')}
              value="private"
              onChange={() => undefined}
              options={VISIBILITIES.map((value) => ({ value, label: label(value) }))}
            />
            <label className="blueprint-opt-in">
              <input type="checkbox" checked={false} onChange={() => undefined} />
              <span>{label('optIn')}</span>
            </label>
            <details open>
              <summary>
                <Text k="blueprint.optional.birth.data" />
              </summary>
              <Field label={copyText('blueprint.birth.date.optional')} type="date" value="" onChange={() => undefined} />
              <Field label={copyText('blueprint.birth.time.optional')} type="time" value="" onChange={() => undefined} />
              <Field label={copyText('blueprint.birth.place.optional')} value="" onChange={() => undefined} maxLength={200} />
            </details>
          </fieldset>
          <Button type="submit" disabled aria-describedby="blueprint-session-reason">
            {label('start')}
          </Button>
        </form>
        {action.feedback}
      </Panel>
      {action.dialog}
    </div>
  );
}
