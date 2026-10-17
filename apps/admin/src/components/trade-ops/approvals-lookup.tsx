'use client';

import { Button, Field, Input } from '@intafaced/ui';

/**
 * Look up one account by user id. A plain GET form: the id goes into the address (?user=...), so the page is read
 * on the server again and the result can be reloaded or shared with the second person.
 */
export function ApprovalsLookup({ userId, error }: { userId: string; error?: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <Field
        label="Account user id"
        hint="The UUID of the account, as shown in the Accounts room."
        error={error}
        density="dense"
        className="w-[26rem] max-w-full"
      >
        <Input
          name="user"
          defaultValue={userId}
          density="dense"
          placeholder="3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Button type="submit" variant="secondary" shape="rounded" size={32}>
        {userId ? 'Reload account' : 'Look up'}
      </Button>
    </form>
  );
}
