/** R1 startup guards: refuse to serve with weak secrets or active default/demo accounts (staging/production). */
import { config, isHardened, productionConfigProblems } from './config';
import { prisma } from './lib/prisma';
import { findLegacyAccounts } from './services/legacyAccounts';

export async function preflightProblems(): Promise<string[]> {
  const problems = productionConfigProblems(process.env, config.appEnv);
  if (isHardened) {
    const legacy = (await findLegacyAccounts(prisma as any)).filter((a) => a.risky);
    if (legacy.length) problems.push(`Active legacy default/demo accounts found (${legacy.map((a) => a.username).join(', ')}).`);
    if (config.appEnv === 'production') {
      const demo = await prisma.user.count({ where: { isActive: true, email: { endsWith: '@example.invalid' } } });
      if (demo) problems.push(`${demo} active demo account(s) (@example.invalid) found in production.`);
    }
  }
  return problems;
}
