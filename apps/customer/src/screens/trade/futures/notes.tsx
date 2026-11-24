import { StateBlock, type StateAction } from '@intafaced/ui/lit';

/**
 * A region's honest empty or refused line, drawn with the kit's StateBlock. A refusal or a switched-off part is a
 * status (read out when it appears), as it always was on this desk; an empty region is not.
 */
export function RegionNote({
  variant = 'empty',
  title,
  reason,
  code,
  action,
}: {
  variant?: 'empty' | 'refused' | 'unavailable';
  title: string;
  reason?: string;
  code?: string;
  action?: StateAction;
}) {
  if (variant === 'empty') return <StateBlock kind="empty" title={title} body={reason} action={action} />;
  return (
    <div role="status" data-variant={variant}>
      <StateBlock kind="refused" title={title} body={reason} code={code} action={action} />
    </div>
  );
}
