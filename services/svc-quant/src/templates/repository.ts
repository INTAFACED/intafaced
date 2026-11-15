import type { QuantSignalRules } from '@intafaced/contracts';

/** First-party starter templates (AL-editor-03): versioned, published by an operator, readable from any allowed jurisdiction (they hold nothing account-private). */
export interface TemplateVersion {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly rules: QuantSignalRules;
  readonly releaseNote: string;
  readonly publishedAt: string;
}

export interface TemplatePublishInput {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rules: QuantSignalRules;
  readonly releaseNote: string;
  readonly reason: string;
  readonly publishedBy: string;
  readonly idempotencyKey: string;
}

/** An operator takes a template off the list (`listed: false`) or puts it back (`listed: true`), with a reason. */
export interface TemplateListingInput {
  readonly id: string;
  readonly listed: boolean;
  readonly reason: string;
  readonly setBy: string;
  readonly idempotencyKey: string;
}

export interface TemplateListing {
  readonly id: string;
  readonly listed: boolean;
  readonly setAt: string;
}

export interface TemplatePage {
  readonly templates: readonly TemplateVersion[];
  readonly nextCursor: string | null;
}

export interface TemplateRepository {
  /** Appends the next version of a template. The same key with the same content returns the first result. */
  publish(input: TemplatePublishInput): Promise<TemplateVersion>;
  /** The newest version of each listed template, in id order, after `cursor` (a template id). */
  list(input: { limit: number; cursor?: string | null }): Promise<TemplatePage>;
  /** Every version of one listed template, newest first; null when none is published or it is withdrawn. */
  get(id: string): Promise<readonly TemplateVersion[] | null>;
  /**
   * Withdraws or restores a published template; its versions are never touched. Refuses a template with no version
   * (`quant.template_not_found`). The same key with the same id and state returns the first result.
   */
  setListed(input: TemplateListingInput): Promise<TemplateListing>;
}

/** What a replayed publish must match: everything the operator sent except the reason. */
export function sameContent(
  a: Omit<TemplateVersion, 'version' | 'publishedAt'>,
  b: Omit<TemplatePublishInput, 'reason' | 'publishedBy' | 'idempotencyKey'>,
) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.description === b.description &&
    a.releaseNote === b.releaseNote &&
    JSON.stringify(a.rules) === JSON.stringify(b.rules)
  );
}
