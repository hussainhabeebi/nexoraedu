/**
 * Financial reconciliation from the command line (read-only; changes nothing).
 *   npm run finance:reconcile                 # all students
 *   npm run finance:reconcile -- --student <id>
 * Exit code 1 when any ERROR is found (usable in scheduled checks / alerting).
 */
import { reconcile } from '../services/reconciliation';
import { prisma } from '../lib/prisma';

const i = process.argv.indexOf('--student');
reconcile({ studentId: i > 0 ? process.argv[i + 1] : undefined })
  .then((r) => {
    console.log(JSON.stringify({ generatedAt: r.generatedAt, timeZone: r.timeZone, checked: r.checked, ok: r.ok, bySeverity: r.bySeverity, byRule: r.byRule }, null, 2));
    for (const x of r.issues.filter((x) => x.severity !== 'INFO').slice(0, 200)) console.log(`${x.severity} ${x.rule} ${x.entity}:${x.entityId} expected=${x.expected ?? ''} actual=${x.actual ?? ''} — ${x.message}`);
    if (!r.ok) process.exitCode = 1;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
