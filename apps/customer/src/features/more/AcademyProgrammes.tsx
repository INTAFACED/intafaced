import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, TextArea, useAction } from './common';
const uuid = z.string().uuid(),
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
export function AcademyProgrammes({ action }: { action: ReturnType<typeof useAction> }) {
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
            .refine((rows) => rows.every((row) => row.userId === userId), 'Residency ownership does not match this account'),
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
        <Panel title="Your residency applications">
          <Read resource={mine.resource} retry={mine.reload} empty="You have no residency applications">
            {(rows) => (
              <>
                <DataTable headers={['Cohort', 'Status', 'Decision', 'Action']} label="Residency applications">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.cohortSlug}</td>
                      <td>{r.status}</td>
                      <td>{r.decisionNote ?? 'No decision recorded'}</td>
                      <td>
                        <Button
                          variant="secondary"
                          disabled={action.disabled || r.status !== 'applied'}
                          onClick={() =>
                            action.stage({
                              title: 'Withdraw residency application',
                              confirm: 'Withdraw application',
                              success: 'Application withdrawn',
                              content: <p>Withdraw your application for {r.cohortSlug}.</p>,
                              run: () => api.mutate('academy', 'withdrawResidency', { id: r.id }, residency),
                              done: mine.reload,
                            })
                          }
                        >
                          Withdraw
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
        <Panel title="Tournament seasons">
          <Read resource={seasons.resource} retry={seasons.reload} empty="No tournament seasons are published">
            {(rows) => (
              <>
                {rows.map((s) => (
                  <article key={s.id}>
                    <h3>{s.title}</h3>
                    <p>{s.rulesSummary}</p>
                    <small>
                      {s.status} · {s.startsAt} → {s.endsAt ?? 'End not supplied'}
                    </small>
                    <Button variant="secondary" onClick={() => setSelected(s.id)}>
                      Read standings
                    </Button>
                  </article>
                ))}
                <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
              </>
            )}
          </Read>
          {selected && (
            <Read resource={standings.resource} retry={standings.reload} empty="No standings have been recorded">
              {(rows) => (
                <DataTable headers={['Rank', 'Participant', 'Score']} label="Tournament standings">
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
            Scores are published records. Season control and scoring belong to operators. Prize pools and beneficiary pay are unavailable
            without published funding and ledger recipes.
          </p>
        </Panel>
      </div>
      <Panel title="Apply for a residency">
        <p className="muted">
          Use a cohort slug supplied by the programme. The API has no public cohort catalogue. Applications record your statement and move
          no funds.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: 'Review residency application',
              confirm: 'Submit application',
              success: 'Residency application received',
              content: (
                <Details
                  items={[
                    ['Cohort', cohort],
                    ['Statement', statement],
                  ]}
                />
              ),
              run: () => api.mutate('academy', 'applyResidency', { cohortSlug: cohort, statement }, residency),
              done: mine.reload,
            });
          }}
        >
          <Field label="Programme cohort slug" value={cohort} onChange={(e) => setCohort(e.target.value)} maxLength={48} />
          <TextArea label="Application statement" value={statement} onChange={setStatement} maxLength={2000} />
          <Button type="submit" disabled={action.disabled || cohort.length < 3 || statement.trim().length < 20}>
            Review residency application
          </Button>
        </form>
      </Panel>
    </div>
  );
}
