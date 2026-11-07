import { createApp } from './app';
import { config, databaseIsolationProblem, isHardened, productionConfigProblems } from './config';
import { startScheduler } from './jobs/scheduler';
import { prisma } from './lib/prisma';
import { findLegacyAccounts } from './cli/legacy-accounts';

/** R1 startup guards: refuse to serve with weak secrets, a cross-environment database, or default accounts. */
async function preflight() {
  const problems = productionConfigProblems(process.env, config.appEnv);
  const db = databaseIsolationProblem(config.databaseUrl, config.appEnv, config.productionDbHosts);
  if (db) problems.push(db);
  if (isHardened) {
    const legacy = (await findLegacyAccounts(prisma as any)).filter((a) => a.risky);
    if (legacy.length) problems.push(`Active legacy default/demo accounts found (${legacy.map((a) => a.username).join(', ')}). Run \`npm run accounts:legacy\` and, after approval, \`--apply\`.`);
    if (config.appEnv === 'production') {
      const demo = await prisma.user.count({ where: { isActive: true, email: { endsWith: '@example.invalid' } } });
      if (demo) problems.push(`${demo} active demo account(s) (@example.invalid) found in production.`);
    }
  }
  if (problems.length) {
    console.error(`Refusing to start (APP_ENV=${config.appEnv}):\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
}

preflight().then(() => {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Nexora API listening on :${config.port} (APP_ENV=${config.appEnv})`);
    if (config.jobsEnabled) startScheduler();
  });
});
