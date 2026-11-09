import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  // /api goes to the local Worker started with `npm run dev` at the repository root.
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
