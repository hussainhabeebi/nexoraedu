// Minimal declarations for the Cloudflare runtime modules used by src/worker.ts (kept small so they do not
// clash with the Node.js types the rest of the backend uses).
declare module 'cloudflare:node' {
  export function httpServerHandler(opts: { port: number }): unknown;
}
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
  export function waitUntil(p: Promise<unknown>): void;
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
}
interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}
declare module 'pdfkit/standard-fonts/*' {
  const font: unknown;
  export default font;
}
