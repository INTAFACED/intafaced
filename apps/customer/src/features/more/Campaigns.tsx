import { useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { Button, Field, Panel } from '../../shared/ui';
import { Details, Select, TextArea, useAction } from './common';
const result = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('refuse'),
    reason: z.enum(['warehouse_dark', 'autonomous_publish', 'returns_claim', 'budget_undecided', 'inputs_missing']),
    isPublication: z.literal(false),
    published: z.literal(false),
    warehouseConfigured: z.boolean(),
    warehouseMayLabelLive: z.boolean(),
    inventedReturns: z.literal(false),
    inventedBudget: z.literal(false),
  }),
  z.object({
    status: z.literal('proposal'),
    headline: z.string(),
    isPublication: z.literal(false),
    published: z.literal(false),
    warehouseConfigured: z.literal(true),
    warehouseMayLabelLive: z.literal(true),
    inventedReturns: z.literal(false),
    inventedBudget: z.literal(false),
  }),
]);
export function Campaigns() {
  const api = useApi(),
    action = useAction('campaigns');
  const [headline, setHeadline] = useState(''),
    [copy, setCopy] = useState(''),
    [response, setResponse] = useState<z.infer<typeof result> | null>(null);
  return (
    <div className="more-columns">
      <Panel title="Signed-in campaign proposal">
        <p className="muted">
          Prepare a proposal for human review. The service requires an available analytics warehouse, rejects return claims and undecided
          incentive budgets, and never publishes automatically.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: 'Review campaign proposal',
              confirm: 'Request draft assessment',
              success: 'Draft assessment received',
              content: (
                <Details
                  items={[
                    ['Headline', headline],
                    ['Copy', copy],
                    ['Publication', 'No publication requested'],
                  ]}
                />
              ),
              run: async () => {
                const res = await api.mutate('agents', 'growth.propose', { headline, copy, publish: false }, result);
                if (res.ok && action.isCurrent()) setResponse(res.data);
                return res;
              },
            });
          }}
        >
          <Field label="Campaign headline" value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={200} />
          <TextArea label="Campaign copy" value={copy} onChange={setCopy} maxLength={2000} />
          <Button type="submit" disabled={action.disabled || !headline.trim() || !copy.trim()}>
            Review campaign proposal
          </Button>
        </form>
        {action.feedback}
        {response && (
          <p role="status">
            {response.status === 'refuse'
              ? `No campaign proposal was produced: ${response.reason}.`
              : `Proposal received: ${response.headline}. Publication remains a separate human action.`}
          </p>
        )}
      </Panel>
      <Panel title="Campaign activity">
        <p>
          The service publishes draft assessment, but no customer campaign catalogue, participation history, reward budget or publication
          endpoint. These records cannot be shown as an empty list of completed campaigns.
        </p>
        <p>
          Email, push and SMS campaign delivery require a published channel configuration and audience permission contract. This room cannot
          trigger an operator broadcast.
        </p>
        <a className="text-link" href="/lab">
          Open public campaigns
        </a>
      </Panel>
      {action.dialog}
    </div>
  );
}
