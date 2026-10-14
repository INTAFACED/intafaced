import { useState } from 'react';
import { CornerDownLeft, Compass, Send } from 'lucide-react';
import { StatusTag } from '@intafaced/ui';
import { fmtUsd } from '../../../data/format';
import { PreviewActionButton, PreviewChip, usePreviewSheet } from '../../../preview';
import type { SampleCommand } from '../../../preview/fixtures/agents';
import { agentsCopy } from './copy';

const planKey = { inside: 'Plan inside', asked: 'Plan asked', blocked: 'Plan blocked' } as const;

/**
 * The Navigator command bar. Typing is local. Send, Approve and Decline open the "nothing was sent" sheet. The chips fill the bar and
 * show a sample reply, so the "suggest, you approve" flow can be seen without sending anything.
 */
export function NavigatorBar({ commands }: { commands: readonly SampleCommand[] }) {
  const { t } = agentsCopy.useCopy();
  const sheet = usePreviewSheet();
  const [text, setText] = useState('');
  const [shown, setShown] = useState<SampleCommand | null>(null);
  return (
    <section className="if-preview__panel ag-navigator" aria-labelledby="ag-nav-h" data-testid="agents-navigator">
      <div className="if-preview__panel-head">
        <span className="ag-navigator__icon" aria-hidden="true">
          <Compass size={18} strokeWidth={1.75} />
        </span>
        <h2 className="if-preview__h2" id="ag-nav-h">
          {t('Navigator heading')}
        </h2>
        <PreviewChip />
      </div>
      <p className="ag-fine">{t('Navigator line')}</p>
      <div className="ag-command">
        <input
          className="ag-command__input"
          type="text"
          aria-label={t('Command label')}
          placeholder={t('Command placeholder')}
          value={text}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && text.trim() !== '') sheet.open('agents');
          }}
        />
        <PreviewActionButton product="agents" variant="primary" size={40}>
          <Send size={16} strokeWidth={1.75} aria-hidden="true" />
          {t('Send')}
        </PreviewActionButton>
      </div>
      <div className="ag-chips" role="group" aria-label={t('Try one')}>
        <span className="ag-chips__label">{t('Try one')}</span>
        {commands.map((command) => (
          <button
            key={command.text}
            type="button"
            className="ag-chip"
            aria-pressed={shown?.text === command.text}
            onClick={() => {
              setText(command.text);
              setShown(command);
            }}
          >
            <CornerDownLeft size={14} strokeWidth={1.75} aria-hidden="true" />
            {command.text}
          </button>
        ))}
      </div>
      {shown ? (
        <div className="ag-plan" data-check={shown.check} data-testid="agents-plan" aria-live="polite">
          <p className="ag-plan__says">{t('Navigator says')}</p>
          <p className="ag-plan__reply">{shown.reply}</p>
          <h3 className="ag-h3">{t('Plan heading')}</h3>
          <ol className="ag-plan__steps">
            {shown.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="ag-plan__foot">
            <StatusTag status={shown.check === 'inside' ? 'filled' : shown.check === 'asked' ? 'pending' : 'failed'} label={t(planKey[shown.check])} />
            <span className="ag-plan__size">
              {t('Plan size')}: <span className="if-num">{shown.size === null ? t('Plan none') : fmtUsd(shown.size)}</span>
            </span>
            <span className="ag-plan__buttons">
              <PreviewActionButton product="agents" variant="primary" size={32}>
                {t('Approve')}
              </PreviewActionButton>
              <PreviewActionButton product="agents" variant="secondary" size={32}>
                {t('Decline')}
              </PreviewActionButton>
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
