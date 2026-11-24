import { RefusalBox } from '@intafaced/ui/lit/templates';
import { refusalCopy } from './deps';

/**
 * Pay's balances read refused by the bank, for a person not yet verified say: the refusal's own words and its way
 * forward, never "couldn't load", which would say something broke. The raw code never reaches the screen.
 */
export function SpacesRefused({ code }: { code: string }) {
  const words = refusalCopy(code);
  return (
    <div data-testid="pay-spaces-refused" data-slot="state-block" data-kind="refused">
      <RefusalBox
        refusal={{ variant: 'refused', title: words.title, body: words.body, reference: words.reference, action: words.action }}
      />
    </div>
  );
}
