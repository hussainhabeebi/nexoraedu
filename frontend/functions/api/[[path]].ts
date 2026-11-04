/**
 * Cloudflare Pages Function: proxies /api/* (API, webhooks, Swagger) to the Nexora backend
 * so the site and API share one origin (nexoraedu.com). Set API_ORIGIN in the Pages project
 * (e.g. https://api.nexoraedu.com — the Cloudflare Tunnel hostname of the backend).
 */
interface Env { API_ORIGIN: string; PROXY_SECRET?: string }

export const onRequest = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.API_ORIGIN) return new Response(JSON.stringify({ error: { message: 'API_ORIGIN not configured' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', 'https');
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) headers.set('X-Forwarded-For', ip);
  headers.delete('X-Client-IP');
  headers.delete('X-Proxy-Secret');
  if (ip && env.PROXY_SECRET) {
    // Backend trusts X-Client-IP only with the shared secret (rate limiting, audit IPs).
    headers.set('X-Client-IP', ip);
    headers.set('X-Proxy-Secret', env.PROXY_SECRET);
  }
  return fetch(new Request(target.toString(), { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' }));
};
