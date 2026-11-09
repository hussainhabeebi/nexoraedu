/**
 * Links that are sent to people (activation, password reset). Only the ORIGIN of PUBLIC_APP_URL is used, and the
 * path is always the frontend page, so a PUBLIC_APP_URL that wrongly includes a path (for example ".../api/v1/auth")
 * can never produce a link to an API route.
 */
import { config } from '../config';

export function appOrigin(publicAppUrl: string = config.publicAppUrl): string {
  return new URL(publicAppUrl).origin;
}

/** `<origin>/reset-password?token=…` plus `&activate=1` for first-time activation. */
export function resetPasswordLink(token: string, opts: { activate?: boolean; publicAppUrl?: string } = {}): string {
  const u = new URL('/reset-password', appOrigin(opts.publicAppUrl));
  u.searchParams.set('token', token);
  if (opts.activate) u.searchParams.set('activate', '1');
  return u.toString();
}
