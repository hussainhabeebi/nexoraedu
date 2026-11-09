import { defineConfig } from 'prisma/config';

// Used only by the Prisma CLI (client generation and `migrate diff` to produce D1 migration SQL).
// The running Worker connects to D1 through the binding, never through a URL.
export default defineConfig({ schema: 'prisma/schema.prisma', datasource: { url: 'file:./.prisma-cli.db' } });
