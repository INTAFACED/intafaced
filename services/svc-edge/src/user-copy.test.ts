import { describe, expect, it } from 'vitest';
import { userCopy } from './user-copy.js';

/**
 * Unit card — user-visible edge copy resolves @intafaced/i18n keys
 * 1. Promise: TRK-infra.i18n slice — public/proxy refuse strings on the door
 * 2. Break: unknown key invents English instead of echoing the dotted name
 * 3. Done bar: known key renders catalog copy; unknown key === key string
 * 4. Class N
 * 5. Paths: services/svc-edge + packages/i18n consumer pin (do not edit catalog)
 * 6. RED: unknown key becomes a sentence
 * 7. Collision: none vs svc-matching / packages/i18n catalog
 */
describe('userCopy — catalog keys, never invented English', () => {
  it('resolves a known catalog key from @intafaced/i18n', () => {
    expect(userCopy('error.notFound')).toBe('We could not find that.');
    expect(userCopy('edge.no_route')).toBe('We could not find that.');
    expect(userCopy('edge.s2s_not_proxied')).toBe('We could not find that.');
    expect(userCopy('edge.unresolvable_path')).toBe('We could not find that.');
    expect(userCopy('edge.origin_not_allowed')).toBe('You do not have access to this.');
    expect(userCopy('auth.csrf_origin_required')).toBe('You do not have access to this.');
    expect(userCopy('error.forbidden')).toBe('You do not have access to this.');
    expect(userCopy('edge.rate_limited')).toBe('Too many requests. Wait a moment.');
    expect(userCopy('error.rateLimited')).toBe('Too many requests. Wait a moment.');
    expect(userCopy('edge.upstream_unavailable')).toBe('No connection. Check your network.');
    expect(userCopy('edge.authority_unavailable')).toBe('Something went wrong. Try again.');
    expect(userCopy('edge.upstream_unwired')).toBe('No connection. Check your network.');
    expect(userCopy('edge.geo_blocked')).toBe('This is not available in your region.');
    expect(userCopy('edge.geo_region_unknown')).toBe('This is not available in your region.');
    expect(userCopy('error.region.blocked')).toBe('This is not available in your region.');
    expect(userCopy('edge.kill_switch_undecidable')).toBe('Something went wrong. Try again.');
    expect(userCopy('error.generic')).toBe('Something went wrong. Try again.');
    expect(userCopy('edge.network_flagged')).toBe('You do not have access to this.');
    expect(userCopy('edge.network_dark')).toBe('No connection. Check your network.');
    expect(userCopy('edge.network_unconfigured')).toBe('Something went wrong. Try again.');
  });

  it('renders the dotted key when the key is not in the catalog', () => {
    const missing = 'edge.refuse.this.key.does.not.exist';
    const rendered = userCopy(missing);

    expect(rendered).toBe(missing);
    expect(rendered).not.toMatch(/ /);
    expect(rendered).not.toMatch(/please try|something went wrong|could not find|no route|upstream/i);
  });

  it('does not invent copy for unkeyed edge refuse codes', () => {
    const killed = userCopy('edge.module_killed');
    expect(killed).toBe('edge.module_killed');
    expect(killed).not.toMatch(/ /);
    expect(killed).not.toMatch(/switched off|kill-switch|operator/i);

    const unset = userCopy('edge.screening_unset');
    expect(unset).toBe('edge.screening_unset');
    expect(unset).not.toMatch(/ /);
    expect(unset).not.toMatch(/geo-block|geo-cleared|counsel/i);
  });
});
