import { t as copyText, Text } from './copy';
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
      <Panel title={copyText('campaigns.signed.in.campaign.proposal')}>
        <p className="muted">
          <Text k="campaigns.prepare.a.proposal.for.human.review.the" />
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.stage({
              title: copyText('campaigns.review.campaign.proposal'),
              confirm: copyText('campaigns.request.draft.assessment'),
              success: copyText('campaigns.draft.assessment.received'),
              content: (
                <Details
                  items={[
                    [copyText('campaigns.headline'), headline],
                    [copyText('campaigns.copy'), copy],
                    [copyText('campaigns.publication'), copyText('campaigns.no.publication.requested')],
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
          <Field
            label={copyText('campaigns.campaign.headline')}
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            maxLength={200}
          />
          <TextArea label={copyText('campaigns.campaign.copy')} value={copy} onChange={setCopy} maxLength={2000} />
          <Button type="submit" disabled={action.disabled || !headline.trim() || !copy.trim()}>
            <Text k="campaigns.review.campaign.proposal" />
          </Button>
        </form>
        {action.feedback}
        {response && (
          <p role="status">
            {response.status === 'refuse'
              ? copyText('campaigns.no.campaign.proposal.was.produced', { value1: response.reason })
              : copyText('campaigns.proposal.received.publication.remains.a.separate.human', { value1: response.headline })}
          </p>
        )}
      </Panel>
      <Panel title={copyText('campaigns.campaign.activity')}>
        <p>
          <Text k="campaigns.the.service.publishes.draft.assessment.but.no" />
        </p>
        <p>
          <Text k="campaigns.email.push.and.sms.campaign.delivery.require" />
        </p>
        <a className="text-link" href="/lab">
          <Text k="campaigns.open.public.campaigns" />
        </a>
      </Panel>
      {action.dialog}
    </div>
  );
}
