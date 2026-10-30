/**
 * Which developer sandbox a sandbox key belongs to (`developer_sandbox_keys`). Written when the sandbox door makes the
 * key, and carried to the new key when it is rotated, so the sandbox keeps listing it.
 */
import type { Sql } from 'postgres';

export async function linkSandboxKey(sql: Sql, apiKeyId: string, sandboxId: string): Promise<void> {
  await sql`INSERT INTO developer_sandbox_keys (api_key_id, sandbox_id) VALUES (${apiKeyId}, ${sandboxId})`;
}

/** The rotated key joins the old key's sandbox, if it had one. A live key has none, and nothing is written. */
export async function copySandboxLink(sql: Sql, oldKeyId: string, newKeyId: string): Promise<void> {
  await sql`
    INSERT INTO developer_sandbox_keys (api_key_id, sandbox_id)
    SELECT ${newKeyId}, sandbox_id FROM developer_sandbox_keys WHERE api_key_id = ${oldKeyId}`;
}
