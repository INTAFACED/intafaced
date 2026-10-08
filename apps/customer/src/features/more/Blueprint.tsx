import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, Field, Panel } from '../../shared/ui';
import { Details, Read, Select, TextArea, useAction } from './common';
const uuid = z.string().uuid();
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
export function Blueprint() {
  const api = useApi(),
    { userId } = useSession(),
    preferences = usePreferences(),
    action = useAction('blueprint');
  const [responses, setResponses] = useState([{ key: '', value: '' }]),
    [visibility, setVisibility] = useState('private'),
    [birthDate, setBirthDate] = useState(''),
    [birthTime, setBirthTime] = useState(''),
    [birthPlace, setBirthPlace] = useState(''),
    [mentorAvailable, setMentorAvailable] = useState(false),
    [size, setSize] = useState('portrait'),
    [erase, setErase] = useState(''),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState('');
  const me = useResource(
      (signal) =>
        api.query(
          'blueprint',
          'me',
          undefined,
          blueprint.nullable().refine((row) => !row || row.userId === userId, 'Blueprint ownership does not match this account'),
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
          z.array(mentor).refine((rows) => rows.every((row) => row.studentId === userId), 'Mentor shortlist belongs to another account'),
          { signal },
        ),
      `mentors:${userId}`,
    ),
    share = useResource((signal) => api.query('blueprint', 'card', { size }, card, { signal }), `card:${userId}:${size}`);
  const reload = () => {
    me.reload();
    mentors.reload();
    share.reload();
  };
  return (
    <div className="more-columns">
      <div>
        <Panel title="Identity Blueprint">
          <Read resource={me.resource} retry={me.reload} empty="Your Blueprint has not been created">
            {(record) =>
              record ? (
                <>
                  <Details
                    items={[
                      ['Decision style', record.profile.decisionStyle],
                      ['Risk temperament', record.profile.riskTemperament],
                      ['Energy rhythm', record.profile.energyRhythm],
                      ['Learning mode', record.profile.learningMode],
                      ['Crew role', record.profile.crewRole],
                      ['Visibility', record.visibility],
                      ['Engine build', record.engineVersion],
                    ]}
                  />
                  <a className="text-link" href={`/academy?path=${encodeURIComponent(record.profile.curriculumPath)}`}>
                    Open your {record.profile.curriculumPath} learning path
                  </a>
                  <Select
                    label="Blueprint visibility"
                    value={record.visibility}
                    onChange={(value) =>
                      action.stage({
                        title: 'Review visibility change',
                        confirm: 'Change visibility',
                        success: 'Visibility updated',
                        content: (
                          <p>
                            {value === 'private'
                              ? 'Only you can view your share card.'
                              : value === 'crew'
                                ? 'Signed crew members can view your share card.'
                                : 'Any signed-in account can view your share card. Public unfurl URLs are not built.'}
                          </p>
                        ),
                        run: () => api.mutate('blueprint', 'setVisibility', { visibility: value }, blueprint),
                        done: reload,
                      })
                    }
                    options={['private', 'crew', 'public']}
                  />
                </>
              ) : null
            }
          </Read>
        </Panel>
        <Panel title="Share card">
          <Select label="Card size" value={size} onChange={setSize} options={['portrait', 'landscape']} />
          <Read resource={share.resource} retry={share.reload}>
            {(c) => (
              <>
                {safeCardSvg(c.svg) ? (
                  <>
                    <img
                      className="more-card-image"
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.svg)}`}
                      alt={`${c.size} Identity Blueprint card`}
                      width={c.width}
                      height={c.height}
                    />
                    <Button variant="secondary" onClick={() => download(`identity-blueprint-${c.size}.svg`, c.svg, 'image/svg+xml')}>
                      Download SVG card
                    </Button>
                  </>
                ) : (
                  <p role="alert">The card contains unsupported active or external content and cannot be rendered.</p>
                )}
                {c.raster.status === 'unavailable' ? (
                  <p className="muted">PNG unavailable: {c.raster.reason}</p>
                ) : c.raster.url.startsWith('https:') ? (
                  <a className="text-link" href={c.raster.url} target="_blank" rel="noreferrer">
                    Open rendered PNG
                  </a>
                ) : (
                  <p>PNG URL cannot be verified as a secure destination.</p>
                )}
                <p className="muted">Share mode: {c.shareMode}. Card reads require a signed viewer and follow your visibility.</p>
              </>
            )}
          </Read>
        </Panel>
        <Panel title="Mentor shortlist">
          <Read resource={mentors.resource} retry={mentors.reload} empty="No mentors are shortlisted">
            {(rows) => (
              <ul>
                {rows.map((m) => (
                  <li key={m.mentorId}>
                    <code>{m.mentorId}</code> · {m.fitScore} basis points of fit · {m.status}
                  </li>
                ))}
              </ul>
            )}
          </Read>
          <p className="muted">Mentorship accept and decline actions are not published by this customer API.</p>
        </Panel>
        <Panel title="Your data">
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
            Export Blueprint JSON
          </Button>
          {exportError && <p role="alert">{exportError}</p>}
          <div className="more-danger">
            <h3>Erase your Blueprint</h3>
            <p>
              Hard-delete the profile, crew membership, match records and mentor relationships held by this service. Your financial account
              is separate.
            </p>
            <Field label="Type ERASE BLUEPRINT" value={erase} onChange={(e) => setErase(e.target.value)} />
            <Button
              variant="danger"
              disabled={action.disabled || erase !== 'ERASE BLUEPRINT'}
              onClick={() =>
                action.stage({
                  title: 'Permanently erase Blueprint',
                  confirm: 'Erase Blueprint permanently',
                  success: 'Blueprint erasure confirmed',
                  content: <p>This cannot be undone. The service returns a receipt for the records removed.</p>,
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
              Review permanent erasure
            </Button>
          </div>
        </Panel>
      </div>
      <Panel title="Guided Blueprint session">
        <p className="muted">
          Provide keyed answers for the Neural Engine. Raw answers and optional birth data are forwarded, then dropped by the service. Birth
          data clears when submitted.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const input = {
              locale: preferences.language,
              responses,
              visibility,
              mentorAvailable,
              ...(birthDate
                ? {
                    birthData: { date: birthDate, ...(birthTime ? { time: birthTime } : {}), ...(birthPlace ? { place: birthPlace } : {}) },
                  }
                : {}),
            };
            action.stage({
              title: 'Review Blueprint session',
              confirm: 'Run Blueprint session',
              success: 'Blueprint session completed',
              content: (
                <Details
                  items={[
                    ['Answers', responses.map((r) => `${r.key}: ${r.value}`).join('\n')],
                    ['Visibility', visibility],
                    ['Mentor opt-in', mentorAvailable ? 'Yes' : 'No'],
                    ['Birth data', birthDate ? 'Included for this request only' : 'Not included'],
                  ]}
                />
              ),
              run: () => {
                setBirthDate('');
                setBirthTime('');
                setBirthPlace('');
                return api.mutate(
                  'blueprint',
                  'onboard',
                  input,
                  z.object({
                    blueprint,
                    placement: z.object({
                      crewId: uuid,
                      crewName: z.string(),
                      score: z.number().int(),
                      matchRunId: uuid,
                      crewFormed: z.boolean(),
                    }),
                    mentors: z.array(mentor),
                  }),
                );
              },
              done: reload,
            });
          }}
        >
          {responses.map((r, i) => (
            <fieldset key={i}>
              <legend>Answer {i + 1}</legend>
              <Field
                label={i === 0 ? 'Answer key' : `Answer ${i + 1} key`}
                value={r.key}
                onChange={(e) => setResponses((rows) => rows.map((row, j) => (i === j ? { ...row, key: e.target.value } : row)))}
                maxLength={64}
              />
              <TextArea
                label={i === 0 ? 'Your answer' : `Your answer ${i + 1}`}
                value={r.value}
                onChange={(value) => setResponses((rows) => rows.map((row, j) => (i === j ? { ...row, value } : row)))}
                maxLength={2000}
              />
              {responses.length > 1 && (
                <Button variant="ghost" onClick={() => setResponses((rows) => rows.filter((_, j) => j !== i))}>
                  Remove answer {i + 1}
                </Button>
              )}
            </fieldset>
          ))}
          <Button
            variant="secondary"
            disabled={responses.length >= 64}
            onClick={() => setResponses((rows) => [...rows, { key: '', value: '' }])}
          >
            Add answer
          </Button>
          <Select label="Initial visibility" value={visibility} onChange={setVisibility} options={['private', 'crew', 'public']} />
          <label className="field">
            <span>
              <input type="checkbox" checked={mentorAvailable} onChange={(e) => setMentorAvailable(e.target.checked)} /> Opt in to mentor
              availability
            </span>
          </label>
          <details open>
            <summary>Optional birth data</summary>
            <Field label="Birth date (optional)" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
            <Field label="Birth time (optional)" type="time" value={birthTime} onChange={(e) => setBirthTime(e.target.value)} />
            <Field label="Birth place (optional)" value={birthPlace} onChange={(e) => setBirthPlace(e.target.value)} maxLength={200} />
          </details>
          <Button type="submit" disabled={action.disabled || !responses.every((r) => r.key.trim() && r.value.trim())}>
            Review Blueprint session
          </Button>
        </form>
        {action.feedback}
      </Panel>
      {action.dialog}
    </div>
  );
}
