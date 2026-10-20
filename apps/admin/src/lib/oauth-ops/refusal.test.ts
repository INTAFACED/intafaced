import { describe, expect, it } from 'vitest';
import { explainOAuthFailure, oauthCodeOf, OAUTH_OPS_FORBIDDEN } from './refusal';

const refusal = (status: number, message: string, code: string | null = null) => ({ code, message, status });

describe('oauth refusals', () => {
  it('reads the typed code from the whole message or from the code field, never from prose', () => {
    expect(oauthCodeOf('oauth.operator_denied', null)).toBe('oauth.operator_denied');
    expect(oauthCodeOf('Something about oauth.operator_denied', null)).toBeNull();
    expect(oauthCodeOf('x', 'oauth.app_not_found')).toBe('oauth.app_not_found');
  });

  it('explains a denied operator, including the self-approval case, and says nothing changed', () => {
    const view = explainOAuthFailure({ kind: 'forbidden', refusal: refusal(403, 'oauth.operator_denied'), requestId: null });
    expect(view).toMatchObject({ code: 'oauth.operator_denied', changed: 'no' });
    expect(view.body).toContain('second factor');
    expect(view.body).toContain('cannot approve their own app');
  });

  it('a session the service does not accept at all is the permission refusal', () => {
    const view = explainOAuthFailure({ kind: 'forbidden', refusal: refusal(403, 'Missing scope admin:compliance'), requestId: null });
    expect(view.title).toBe(OAUTH_OPS_FORBIDDEN);
    expect(explainOAuthFailure({ kind: 'forbidden', refusal: refusal(401, ''), requestId: null }).changed).toBe('no');
  });

  it('a missing app is a definite refusal', () => {
    const view = explainOAuthFailure({ kind: 'refused', refusal: refusal(404, 'oauth.app_not_found'), requestId: null });
    expect(view).toMatchObject({ title: 'No such app', changed: 'no' });
  });

  it('a lost reply on a write is an unknown outcome, never a failure or a success', () => {
    expect(explainOAuthFailure({ kind: 'unavailable', uncertain: true, requestId: null }).changed).toBe('unknown');
    expect(explainOAuthFailure({ kind: 'invalid', requestId: null }).changed).toBe('unknown');
  });

  it('a service that has no queue says so', () => {
    expect(explainOAuthFailure({ kind: 'not_built', procedure: 'oauth.apps.queue', requestId: null })).toMatchObject({ code: 'not_built' });
  });
});
