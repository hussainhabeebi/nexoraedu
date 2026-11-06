/**
 * P1: session refresh has its own rate limits (per session family; per IP only without a session) and never uses
 * up the login / MFA allowance, so colleagues sharing one office connection are not signed out by page reloads.
 * Login, MFA and password reset keep the strict per-IP limit. Synthetic users only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeUser, prisma } from './helpers';
import { createSession, REFRESH_COOKIE } from '../src/lib/auth';
import authRouter, { makeAuthLimiter, makeRefreshLimiters } from '../src/routes/auth';

/** Small app with the real limiter factories and stub handlers, so the limits can be low and exact. */
function limitedApp(o: { login: number; perSession: number; anonymous: number }) {
  const app = express();
  app.post('/login', makeAuthLimiter(o.login), (_req, res) => res.json({ ok: 'login' }));
  app.post('/refresh', ...makeRefreshLimiters({ perSession: o.perSession, anonymous: o.anonymous }), (req, res) => res.json({ ok: 'refresh', family: (req as any).refreshFamily ?? null }));
  return app;
}
const cookie = (token: string) => `${REFRESH_COOKIE}=${encodeURIComponent(token)}`;

let alice: { token: string; family: string }, bob: { token: string; family: string };
beforeAll(async () => {
  const mk = async () => {
    const u = await makeUser(['finance_staff']);
    const { session, refreshToken } = await createSession(prisma, { userId: u.id, mfaVerified: true });
    return { token: refreshToken, family: session.familyId };
  };
  [alice, bob] = await Promise.all([mk(), mk()]);
});

describe('Session refresh rate limits (P1)', () => {
  it('limits each signed-in session separately: one person’s reloads never block a colleague on the same connection', async () => {
    const app = limitedApp({ login: 3, perSession: 4, anonymous: 2 });
    for (let i = 0; i < 4; i++) {
      const r = await request(app).post('/refresh').set('Cookie', cookie(alice.token));
      expect(r.status).toBe(200);
      expect(r.body.family).toBe(alice.family);
    }
    const blocked = await request(app).post('/refresh').set('Cookie', cookie(alice.token));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0); // the frontend shows how long to wait
    // Same IP, different session: unaffected.
    for (let i = 0; i < 4; i++) expect((await request(app).post('/refresh').set('Cookie', cookie(bob.token))).status).toBe(200);
  });

  it('refreshes never use up the login / MFA allowance', async () => {
    const app = limitedApp({ login: 3, perSession: 100, anonymous: 100 });
    for (let i = 0; i < 40; i++) expect((await request(app).post('/refresh').set('Cookie', cookie(alice.token))).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await request(app).post('/login')).status).toBe(200);
    expect((await request(app).post('/login')).status).toBe(429); // login keeps its strict per-IP limit
  });

  it('the limit follows the session family across token rotation', async () => {
    const app = limitedApp({ login: 3, perSession: 3, anonymous: 100 });
    const u = await makeUser(['finance_staff']);
    const first = await createSession(prisma, { userId: u.id, mfaVerified: true });
    const rotated = await createSession(prisma, { userId: u.id, mfaVerified: true, familyId: first.session.familyId });
    expect((await request(app).post('/refresh').set('Cookie', cookie(first.refreshToken))).status).toBe(200);
    expect((await request(app).post('/refresh').set('Cookie', cookie(rotated.refreshToken))).status).toBe(200);
    expect((await request(app).post('/refresh').set('Cookie', cookie(rotated.refreshToken))).status).toBe(200);
    expect((await request(app).post('/refresh').set('Cookie', cookie(first.refreshToken))).status).toBe(429); // same family
  });

  it('refreshes without a valid session are limited per IP, separately from signed-in sessions', async () => {
    const app = limitedApp({ login: 3, perSession: 100, anonymous: 2 });
    expect((await request(app).post('/refresh')).status).toBe(200); // no cookie (e.g. login page opened)
    expect((await request(app).post('/refresh').set('Cookie', cookie('not-a-real-token'))).status).toBe(200);
    const blocked = await request(app).post('/refresh').set('Cookie', cookie('another-unknown-token'));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT');
    expect((await request(app).post('/refresh').set('Cookie', cookie(alice.token))).status).toBe(200); // signed-in user unaffected
  });

  it('wiring: /refresh uses the refresh limiters only; login, MFA and password reset keep the login limiter', () => {
    const stack = (path: string) => (authRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post).route.stack.map((s: any) => s.handle);
    const loginLimiter = stack('/login')[0];
    for (const p of ['/login', '/mfa/verify', '/forgot-password', '/reset-password']) expect(stack(p), p).toContain(loginLimiter);
    const refresh = stack('/refresh');
    expect(refresh).not.toContain(loginLimiter);
    expect(refresh.length).toBeGreaterThanOrEqual(4); // identify + per-session + anonymous + handler
  });
});
