import { t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, TextArea, type ActionControls } from './common';
import { AcademyProgrammeOverview, type ProgrammeAction } from './AcademyProgrammeOverview';
const uuid = z.string().guid(),
  residency = z.object({
    id: uuid,
    userId: uuid,
    cohortSlug: z.string(),
    statement: z.string(),
    status: z.enum(['applied', 'accepted', 'rejected', 'withdrawn']),
    appliedAt: z.string(),
    decidedAt: z.string().nullable(),
    decidedBy: uuid.nullable(),
    decisionNote: z.string().nullable(),
  }),
  season = z.object({
    id: uuid,
    slug: z.string(),
    title: z.string(),
    status: z.enum(['scheduled', 'live', 'frozen', 'ended']),
    rulesSummary: z.string(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
  });
export function AcademyProgrammes({ action }: { action: ProgrammeAction }) {
  const api = useApi(),
    { userId } = useSession();
  const [cohort, setCohort] = useState(''),
    [statement, setStatement] = useState(''),
    [limit, setLimit] = useState(50),
    [selected, setSelected] = useState('');
  const mine = useResource(
      (signal) =>
        api.query(
          'academy',
          'myResidencies',
          { limit },
          z
            .array(residency)
            .refine(
              (rows) => rows.every((row) => row.userId === userId),
              copyText('academyprogrammes.residency.ownership.does.not.match.this.account'),
            ),
          { signal },
        ),
      `residencies:${userId}:${limit}`,
    ),
    seasons = useResource(
      (signal) => api.query('academy', 'seasons', { limit }, z.array(season), { signal }),
      `seasons:${userId}:${limit}`,
    ),
    standings = useResource(
      (signal) =>
        selected
          ? api.query(
              'academy',
              'standings',
              { seasonId: selected, limit },
              z.array(z.object({ seasonId: uuid, userId: uuid, score: z.number().int(), updatedAt: z.string(), rank: z.number().int() })),
              { signal },
            )
          : Promise.resolve({ ok: true as const, data: [] }),
      `standings:${userId}:${selected}:${limit}`,
    );
  return (
    <div className="more-columns">
      <div>
        <AcademyProgrammeOverview action={action} />
        <Panel title={copyText('academyprogrammes.your.residency.applications')}>
          <Read resource={mine.resource} retry={mine.reload} empty={copyText('academyprogrammes.you.have.no.residency.applications')}>
            {(rows) => (
              <>
                <DataTable
                  headers={[
                    copyText('academyprogrammes.cohort'),
                    copyText('academyprogrammes.status'),
                    copyText('academyprogrammes.decision'),
                    copyText('academyprogrammes.action'),
                  ]}
                  label={copyText('academyprogrammes.residency.applications')}
                >
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.cohortSlug}</td>
                      <td>{r.status}</td>
                      <td>{r.decisionNote ?? copyText('academyprogrammes.no.decision.recorded')}</td>
                      <td>
                        <Button
                          variant="secondary"
                          disabled={action.disabled || r.status !== 'applied'}
                          onClick={() =>
                            action.stage({
                              title: copyText('academyprogrammes.withdraw.residency.application'),
                              confirm: copyText('academyprogrammes.withdraw.application'),
                              success: copyText('academyprogrammes.application.withdrawn'),
                              content: (
                                <p>
                                  <Text k="academyprogrammes.withdraw.your.application.for" />
                                  {r.cohortSlug}.
                                </p>
                              ),
                              run: () => api.mutate('academy', 'withdrawResidency', { id: r.id }, residency),
                              done: mine.reload,
                            })
                          }
                        >
                          <Text k="academyprogrammes.withdraw" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
                <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
              </>
            )}
          </Read>
        </Panel>
        <Panel title={copyText('academyprogrammes.tournament.seasons')}>
          <Read
            resource={seasons.resource}
            retry={seasons.reload}
            empty={copyText('academyprogrammes.no.tournament.seasons.are.published')}
          >
            {(rows) => (
              <>
                {rows.map((s) => (
                  <article key={s.id}>
                    <h3>{s.title}</h3>
                    <p>{s.rulesSummary}</p>
                    <small>
                      {s.status} · {s.startsAt} → {s.endsAt ?? copyText('academyprogrammes.end.not.supplied')}
                    </small>
                    <Button variant="secondary" onClick={() => setSelected(s.id)}>
                      <Text k="academyprogrammes.read.standings" />
                    </Button>
                  </article>
                ))}
                <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
              </>
            )}
          </Read>
          {selected && (
            <Read
              resource={standings.resource}
              retry={standings.reload}
              empty={copyText('academyprogrammes.no.standings.have.been.recorded')}
            >
              {(rows) => (
                <DataTable
                  headers={[
                    copyText('academyprogrammes.rank'),
                    copyText('academyprogrammes.participant'),
                    copyText('academyprogrammes.score'),
                  ]}
                  label={copyText('academyprogrammes.tournament.standings')}
                >
                  {rows.map((s) => (
                    <tr key={s.userId}>
                      <td>{s.rank}</td>
                      <td>{s.userId}</td>
                      <td>{s.score}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Read>
          )}
          <p className="muted">
            <Text k="academyprogrammes.scores.are.published.records.season.control.and" />
          </p>
        </Panel>
      </div>
      <Panel title={copyText('academyprogrammes.apply.for.a.residency')}>
        <p className="muted">
          <Text k="academyprogrammes.use.a.cohort.slug.supplied.by.the" />
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: copyText('academyprogrammes.review.residency.application'),
              confirm: copyText('academyprogrammes.submit.application'),
              success: copyText('academyprogrammes.residency.application.received'),
              content: (
                <Details
                  items={[
                    [copyText('academyprogrammes.cohort'), cohort],
                    [copyText('academyprogrammes.statement'), statement],
                  ]}
                />
              ),
              run: () => api.mutate('academy', 'applyResidency', { cohortSlug: cohort, statement }, residency),
              done: mine.reload,
            });
          }}
        >
          <Field
            label={copyText('academyprogrammes.programme.cohort.slug')}
            value={cohort}
            onChange={(e) => setCohort(e.target.value)}
            maxLength={48}
          />
          <TextArea
            label={copyText('academyprogrammes.application.statement')}
            value={statement}
            onChange={setStatement}
            maxLength={2000}
          />
          <Button type="submit" disabled={action.disabled || cohort.length < 3 || statement.trim().length < 20}>
            <Text k="academyprogrammes.review.residency.application" />
          </Button>
        </form>
      </Panel>
    </div>
  );
}
