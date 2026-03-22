import { randomBytes } from 'crypto';

export function buildAnonymousUserId(prefix: string = 'guest'): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

export function resolveRestUserId(params: {
  sessionUserId?: string | null;
  requestedUserId?: string | null;
  hasApiToken: boolean;
}): string {
  if (params.sessionUserId) return params.sessionUserId;
  if (params.hasApiToken && params.requestedUserId?.trim()) return params.requestedUserId.trim();
  return buildAnonymousUserId('api');
}

export function resolveSocketUserId(sessionUserId?: string | null): string {
  return sessionUserId || buildAnonymousUserId('web');
}

export function canAccessSensitiveRoute(params: {
  hasSession: boolean;
  hasApiToken: boolean;
}): boolean {
  return params.hasSession || params.hasApiToken;
}
