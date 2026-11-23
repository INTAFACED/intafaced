// volt-room: /blueprint
import { useRef, useState } from 'react';
import { Button, Checkbox, Field, Select } from '@intafaced/ui/lit';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { BLUEPRINT_ERASE, BLUEPRINT_EXPORT, BLUEPRINT_SET_VISIBILITY } from '@intafaced/contracts/blueprint-procedures';
import { useApi, useSession } from '../../session';
import { BlueprintCrew } from '../BlueprintCrew';
import { BlueprintMentorCardAction, BlueprintSharedCard } from '../BlueprintSharedCard';
import { safeCardSvg } from '../blueprint-card-svg';
import {
  CARD_SIZES,
  VISIBILITIES,
  download,
  downloaded,
  isCardSize,
  isVisibility,
  useBlueprintReads,
  type CardSize,
} from '../blueprint-reads';
import { blueprintSessionCopy } from '../blueprint-session-copy';
import { Details } from '../catalogue-parts';
import { birthDateOptions } from '../birth-date';
import { copy, t as copyText, Text } from '../copy';
import { useKitAction } from '../volt-action';
import { KitRead, Section } from '../volt-parts';

/**
 * /blueprint on the kit: the crew read, the shared-card reader, the person's own Blueprint with its visibility, the share
 * card, the mentor shortlist, the export and the erasure, and the guided session laid out in full and switched off with
 * its reason. The same reads, words and actions as the old view (`../Blueprint.tsx`), which /blueprint/crew still draws.
 */
export function BlueprintRoom({ path }: { path: string }) {
  const api = useApi(),
    { userId } = useSession(),
    action = useKitAction('blueprint'),
    { t: label } = blueprintSessionCopy.useCopy(),
    { renderedLocale } = copy.useCopy();
  const birth = birthDateOptions(renderedLocale, copyText('blueprint.birth.not.given'), new Date().getUTCFullYear());
  const [size, setSize] = useState<CardSize>('portrait'),
    [erase, setErase] = useState(''),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState('');
  const { me, mentors, share, reload } = useBlueprintReads(size);
  const currentMentors = useRef(mentors.resource);
  currentMentors.current = mentors.resource;
  return (
    <CatalogueTemplate
      title={copyText('moreroutes.identity.blueprint')}
      description={copyText('moreroutes.a.profile.you.can.keep.private.share')}
      state={{ kind: 'ready' }}
      items={
        <>
          <div className="lt-grid lt-grid-main-side">
            <div className="lt-col-main">
              <BlueprintCrew />
              <BlueprintSharedCard path={path} />
              <Section title={copyText('blueprint.identity.blueprint')}>
                <KitRead resource={me.resource} retry={me.reload} empty={copyText('blueprint.your.blueprint.has.not.been.created')}>
                  {(record) =>
                    record ? (
                      <div className="lt-stack">
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
                        <a className="lt-link" href={`/academy?path=${encodeURIComponent(record.profile.curriculumPath)}`}>
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
                      </div>
                    ) : null
                  }
                </KitRead>
              </Section>
              <Section title={copyText('blueprint.share.card')}>
                <Select
                  label={copyText('blueprint.card.size')}
                  value={size}
                  onChange={(value) => isCardSize(value) && setSize(value)}
                  options={CARD_SIZES.map((value) => ({ value, label: label(value) }))}
                />
                <KitRead resource={share.resource} retry={share.reload}>
                  {(c) => (
                    <div className="lt-stack">
                      {safeCardSvg(c.svg) ? (
                        <>
                          <img
                            className="lt-media"
                            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.svg)}`}
                            alt={copyText('blueprint.identity.blueprint.card', { value1: c.size })}
                            width={c.width}
                            height={c.height}
                          />
                          <div className="lt-actions">
                            <Button tone="secondary" onClick={() => download(`identity-blueprint-${c.size}.svg`, c.svg, 'image/svg+xml')}>
                              <Text k="blueprint.download.svg.card" />
                            </Button>
                          </div>
                        </>
                      ) : (
                        <p role="alert">
                          <Text k="blueprint.the.card.contains.unsupported.active.or.external" />
                        </p>
                      )}
                      {c.raster.status === 'unavailable' ? (
                        <p className="lt-hint">
                          <Text k="blueprint.png.unavailable" />
                          {c.raster.reason}
                        </p>
                      ) : c.raster.url.startsWith('https:') ? (
                        <a className="lt-link" href={c.raster.url} target="_blank" rel="noreferrer">
                          <Text k="blueprint.open.rendered.png" />
                        </a>
                      ) : (
                        <p>
                          <Text k="blueprint.png.url.cannot.be.verified.as.a" />
                        </p>
                      )}
                      <p className="lt-hint">
                        <Text k="blueprint.share.mode" />
                        {c.shareMode}
                        <Text k="blueprint.card.reads.require.a.signed.viewer.and" />
                      </p>
                    </div>
                  )}
                </KitRead>
              </Section>
              <Section title={copyText('blueprint.mentor.shortlist')}>
                <KitRead resource={mentors.resource} retry={mentors.reload} empty={copyText('blueprint.no.mentors.are.shortlisted')}>
                  {(rows) => (
                    <ul>
                      {rows.map((m) => (
                        <li key={m.mentorId}>
                          <code className="lt-code">{m.mentorId}</code> · {m.fitScore}
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
                </KitRead>
                <p className="lt-hint">{label('mentorLimit')}</p>
              </Section>
              <Section title={copyText('blueprint.your.data')}>
                <div className="lt-actions">
                  <Button
                    tone="secondary"
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
                </div>
                {exportError && <p role="alert">{exportError}</p>}
                <div className="lt-stack">
                  <h3>
                    <Text k="blueprint.erase.your.blueprint" />
                  </h3>
                  <p>
                    <Text k="blueprint.hard.delete.the.profile.crew.membership.match" />
                  </p>
                  <Field label={copyText('blueprint.type.erase.blueprint')} value={erase} onChange={(e) => setErase(e.target.value)} />
                  <div className="lt-actions">
                    <Button
                      tone="secondary"
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
                </div>
              </Section>
            </div>
            <div className="lt-col-side">
              <Section title={copyText('blueprint.guided.blueprint.session')}>
                <p className="lt-hint" id="blueprint-session-reason">
                  {label('unavailable')}
                </p>
                <form onSubmit={(e) => e.preventDefault()} aria-describedby="blueprint-session-reason">
                  <fieldset disabled className="lt-stack">
                    <Select
                      label={copyText('blueprint.initial.visibility')}
                      value="private"
                      onChange={() => undefined}
                      options={VISIBILITIES.map((value) => ({ value, label: label(value) }))}
                    />
                    <Checkbox checked={false} onCheckedChange={() => undefined}>
                      {label('optIn')}
                    </Checkbox>
                    <details open>
                      <summary>
                        <Text k="blueprint.optional.birth.data" />
                      </summary>
                      <div className="lt-stack">
                        <fieldset className="lt-stack">
                          <legend>{copyText('blueprint.birth.date.optional')}</legend>
                          <div className="lt-toolbar">
                            <Select label={copyText('blueprint.birth.day')} value="" onChange={() => undefined} options={birth.days} />
                            <Select label={copyText('blueprint.birth.month')} value="" onChange={() => undefined} options={birth.months} />
                            <Select label={copyText('blueprint.birth.year')} value="" onChange={() => undefined} options={birth.years} />
                          </div>
                        </fieldset>
                        <Field label={copyText('blueprint.birth.time.optional')} type="time" value="" onChange={() => undefined} />
                        <Field label={copyText('blueprint.birth.place.optional')} value="" onChange={() => undefined} maxLength={200} />
                      </div>
                    </details>
                  </fieldset>
                  <div className="lt-actions">
                    <Button tone="primary" type="submit" disabled aria-describedby="blueprint-session-reason">
                      {label('start')}
                    </Button>
                  </div>
                </form>
                {action.feedback}
              </Section>
            </div>
          </div>
          {action.dialog}
        </>
      }
    />
  );
}
