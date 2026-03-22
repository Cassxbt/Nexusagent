import { describe, expect, it } from 'vitest';
import {
  buildAnonymousUserId,
  canAccessSensitiveRoute,
  resolveRestUserId,
  resolveSocketUserId,
} from '../../src/web/access.js';

describe('web access helpers', () => {
  it('builds anonymous ids with the requested prefix', () => {
    expect(buildAnonymousUserId('guest')).toMatch(/^guest-[0-9a-f]+$/);
  });

  it('prefers the authenticated session user for REST requests', () => {
    expect(resolveRestUserId({
      sessionUserId: 'wallet:alice',
      requestedUserId: 'wallet:bob',
      hasApiToken: true,
    })).toBe('wallet:alice');
  });

  it('allows api-token callers to choose the request user id', () => {
    expect(resolveRestUserId({
      sessionUserId: null,
      requestedUserId: 'openclaw-worker',
      hasApiToken: true,
    })).toBe('openclaw-worker');
  });

  it('generates an anonymous rest user id when no session or api token exists', () => {
    expect(resolveRestUserId({
      sessionUserId: null,
      requestedUserId: 'wallet:target',
      hasApiToken: false,
    })).toMatch(/^api-[0-9a-f]+$/);
  });

  it('generates anonymous socket ids when unauthenticated', () => {
    expect(resolveSocketUserId()).toMatch(/^web-[0-9a-f]+$/);
    expect(resolveSocketUserId('wallet:alice')).toBe('wallet:alice');
  });

  it('requires either a session or an api token for sensitive routes', () => {
    expect(canAccessSensitiveRoute({ hasSession: false, hasApiToken: false })).toBe(false);
    expect(canAccessSensitiveRoute({ hasSession: true, hasApiToken: false })).toBe(true);
    expect(canAccessSensitiveRoute({ hasSession: false, hasApiToken: true })).toBe(true);
  });
});
