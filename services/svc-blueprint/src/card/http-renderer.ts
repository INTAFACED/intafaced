import { responseSchema } from './renderer-response.js';
import type { CardRaster } from '@intafaced/contracts';
import type { CardRasterizeRequest, CardRenderer } from './card-renderer.js';

/**
 * HttpCardRenderer — the real rasterization adapter.
 *
 * Posts the composed SVG to an external renderer at `BLUEPRINT_CARD_RENDERER_URL`
 * and expects back the URL of a hosted PNG. The renderer owns the rasterizer,
 * the fonts and the object storage; this class owns one POST, one schema check
 * and one error taxonomy — the same shape as `HttpNeuralEngineClient`, on
 * purpose.
 *
 * ── Every failure here is `unavailable`, never a URL ────────────────────────
 *
 * Timeout, transport error, non-2xx, unparseable body, or a body that does not
 * match the contract: all of them return the `unavailable` arm with a code. None
 * of them returns a URL, and none of them throws — the caller is producing a
 * card that is already complete without this, so a throw would turn a fully
 * successful request into a 500.
 *
 * The distinction the codes carry is the one an operator needs: `unreachable`
 * means the renderer is down or slow and this will retry itself into working;
 * `protocol` means it answered and we could not use the answer, which is a
 * contract mismatch with a different owner and no amount of retrying fixes it.
 */

export interface HttpCardRendererOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  /** Sent as `authorization: Bearer …` when present. Never logged. */
  readonly apiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class HttpCardRenderer implements CardRenderer {
  readonly id = 'card-renderer-http';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpCardRendererOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async rasterize(request: CardRasterizeRequest): Promise<CardRaster> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/render`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          svg: request.svg,
          format: 'png',
          width: request.width,
          height: request.height,
          // The asset key. Stable per blueprint and size, so a re-render
          // replaces the object instead of orphaning the previous one — which
          // also means erasure has one path to delete, not a growing set.
          key: `blueprint/${request.blueprintId}/${request.size}.png`,
        }),
      });
    } catch (err) {
      return {
        status: 'unavailable',
        code: 'blueprint.card_renderer_unreachable',
        reason: controller.signal.aborted
          ? `Card renderer timed out after ${this.timeoutMs}ms`
          : `Card renderer is unreachable: ${describe(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return {
        status: 'unavailable',
        code: 'blueprint.card_renderer_unreachable',
        reason: `Card renderer returned ${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        status: 'unavailable',
        code: 'blueprint.card_renderer_protocol',
        reason: 'Card renderer returned a body that is not JSON',
      };
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        status: 'unavailable',
        code: 'blueprint.card_renderer_protocol',
        // Paths only. The body is ours going out, but an error message that
        // quotes a response is one bad renderer away from logging the card.
        reason: `Card renderer response did not match the contract: ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`,
      };
    }

    return { status: 'rendered', url: parsed.data.url, contentType: 'image/png', bytes: parsed.data.bytes };
  }
}

/** An error reduced to something safe to put in a reason string. */
function describe(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}
