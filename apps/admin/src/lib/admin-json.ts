import { AdminSessionError } from './founder-session';

export async function readAdminJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !request.body)
    throw new AdminSessionError('admin.json_required', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 16_384) {
        await reader.cancel();
        throw new AdminSessionError('admin.body_too_large', 413);
      }
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AdminSessionError) throw error;
    throw new AdminSessionError('admin.json_required', 400);
  } finally {
    reader.releaseLock();
  }
}
