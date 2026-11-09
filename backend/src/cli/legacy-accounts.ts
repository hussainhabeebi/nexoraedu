import { deactivateLegacyAccounts, findLegacyAccounts } from '../services/legacyAccounts';
import { withLocalDb } from './local-db';

export * from '../services/legacyAccounts';

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  withLocalDb((prisma) => (apply ? deactivateLegacyAccounts(prisma) : findLegacyAccounts(prisma))
    .then((rows) => {
      console.table(rows.map(({ id: _id, ...r }) => r));
      console.log(apply ? `Deactivated ${rows.length} account(s).` : 'Dry run: nothing changed. Re-run with --apply to deactivate the rows marked risky.');
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
  );
}
