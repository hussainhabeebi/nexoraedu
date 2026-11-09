/**
 * Local development only: create the first Super Administrator in the local D1 database.
 *   npm run admin:bootstrap:dev -- --email owner@example.com --name "Full Name" --username owner
 * On Cloudflare (staging/production) use POST /api/v1/auth/bootstrap with the BOOTSTRAP_TOKEN secret instead.
 */
import { bootstrapSuperAdmin } from '../services/bootstrap';
import { withLocalDb } from './local-db';

export { ACTIVATION_MINUTES, bootstrapSuperAdmin } from '../services/bootstrap';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  withLocalDb((prisma) => bootstrapSuperAdmin(prisma, { email: arg('email') ?? '', name: arg('name') ?? '', username: arg('username') ?? '', phone: arg('phone'), second: process.argv.includes('--second'), nomination: arg('nomination') }, process.env.PUBLIC_APP_URL || 'http://localhost:5173')
    .then((r) => {
      console.log('Super Administrator created. Activation link (single use, expires in 60 minutes — share only with the account owner):');
      console.log(`  ${r.link}`);
      console.log('After setting a password the owner must enrol an authenticator app (MFA) before using the portal.');
    })
    .catch((e) => {
      console.error(`Bootstrap failed: ${e.message ?? e}`);
      process.exitCode = 1;
    })
  );
}
