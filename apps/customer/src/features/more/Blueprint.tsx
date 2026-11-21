import { t as copyText, Text } from './copy';
import { useEffect, useRef, useState } from 'react';
import {
  BLUEPRINT_CARD,
  BLUEPRINT_ERASE,
  BLUEPRINT_EXPORT,
  BLUEPRINT_ME,
  BLUEPRINT_MENTORS,
  BLUEPRINT_SET_VISIBILITY,
} from '@intafaced/contracts/blueprint-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import { Button, Field, Panel } from '../../shared/ui';
import { Details, Read, Select, useAction } from './common';
import { BlueprintSharedCard, BlueprintMentorCardAction } from './BlueprintSharedCard';
import { BlueprintCrew } from './BlueprintCrew';
import { blueprintSessionCopy } from './blueprint-session-copy';

const VISIBILITIES = ['private', 'crew', 'public'] as const;
const CARD_SIZES = ['portrait', 'landscape'] as const;
const isCardSize = (value: string): value is (typeof CARD_SIZES)[number] => (CARD_SIZES as readonly string[]).includes(value);
const isVisibility = (value: string): value is (typeof VISIBILITIES)[number] => (VISIBILITIES as readonly string[]).includes(value);

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

/** The file the export button saves: the reply as the room has always saved it, without the share rows it never kept. */
function downloaded({ shares: _shares, cardsOpened: _cardsOpened, ...kept }: ProcedureOutput<typeof BLUEPRINT_EXPORT>) {
  return kept;
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
  const [size, setSize] = useState<(typeof CARD_SIZES)[number]>('portrait'),
    [erase, setErase] = useState(''),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState('');
  const me = useResource(
      (signal) => api.call(BLUEPRINT_ME, undefined, { signal, accept: (row) => !row || row.userId === userId }),
      `blueprint:${userId}`,
    ),
    mentors = useResource(
      (signal) => api.call(BLUEPRINT_MENTORS, undefined, { signal, accept: (rows) => rows.every((row) => row.studentId === userId) }),
      `mentors:${userId}`,
    ),
    share = useResource((signal) => api.call(BLUEPRINT_CARD, { size }, { signal }), `card:${userId}:${size}`);
  const currentMentors = useRef(mentors.resource);
  currentMentors.current = mentors.resource;
  const reload = () => {
    me.reload();
    mentors.reload();
    share.reload();
  };
  // /blueprint/crew opens on the crew section.
  useEffect(() => {
    if (/^\/blueprint\/crew\/?$/.test(path.split(/[?#]/)[0] ?? ''))
      document.getElementById('blueprint-crew')?.scrollIntoView({ block: 'start' });
  }, [path]);
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
                      isVisibility(value) &&
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
                        run: () => api.call(BLUEPRINT_SET_VISIBILITY, { visibility: value }),
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
            onChange={(value) => isCardSize(value) && setSize(value)}
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
              void api.call(BLUEPRINT_EXPORT, undefined).then((res) => {
                setExporting(false);
                if (res.ok && action.isCurrent())
                  download('identity-blueprint.json', JSON.stringify(downloaded(res.data), null, 2), 'application/json');
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
                  run: () => api.call(BLUEPRINT_ERASE, undefined),
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
