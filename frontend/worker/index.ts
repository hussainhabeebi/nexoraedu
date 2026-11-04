/**
 * Cloudflare Worker for nexoraed.com.
 *  - Static assets (the built React app in ./dist) are served by Workers Static Assets with SPA fallback.
 *  - /api/* and /health are proxied to the Nexora backend (API_ORIGIN, e.g. https://api.nexoraed.com
 *    published via Cloudflare Tunnel), so site and API share one origin.
 */
interface Env {
  API_ORIGIN: string;
  PROXY_SECRET?: string;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

async function proxy(request: Request, env: Env): Promise<Response> {
  if (!env.API_ORIGIN)
    return Response.json({ error: { code: 'NOT_CONFIGURED', message: 'API_ORIGIN is not configured on the Worker.' } }, { status: 503 });
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);
  const headers = new Headers(request.headers);
  const ip = request.headers.get('CF-Connecting-IP');
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', 'https');
  if (ip) headers.set('X-Forwarded-For', ip);
  headers.delete('X-Client-IP');
  headers.delete('X-Proxy-Secret');
  if (ip && env.PROXY_SECRET) {
    // Backend trusts X-Client-IP only with the shared secret (rate limiting, audit IPs).
    headers.set('X-Client-IP', ip);
    headers.set('X-Proxy-Secret', env.PROXY_SECRET);
  }
  try {
    return await fetch(target.toString(), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
  } catch {
    return Response.json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The server is temporarily unavailable. Please try again shortly.' } }, { status: 502 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname === '/health') return proxy(request, env);
    return env.ASSETS.fetch(request);
  },
};
