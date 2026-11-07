-- Rollback for 20261106120000_enrollments.
-- Students keep their current course/batch (students.courseId/batchId were kept in sync throughout), so the
-- pre-enrollment code works unchanged. LOST on rollback: the enrollment history rows themselves (transfer chain,
-- start/end dates, closure reasons) — export them first (SELECT * FROM enrollments) if they must be retained.
-- Student history entries and audit log rows describing enrollment changes are NOT removed.
BEGIN;
ALTER TABLE "attendance" DROP CONSTRAINT IF EXISTS "attendance_enrollmentId_fkey";
ALTER TABLE "fee_plans" DROP CONSTRAINT IF EXISTS "fee_plans_enrollmentId_fkey";
ALTER TABLE "attendance" DROP COLUMN IF EXISTS "enrollmentId";
ALTER TABLE "fee_plans" DROP COLUMN IF EXISTS "enrollmentId";
DROP TABLE IF EXISTS "enrollments";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106120000_enrollments';
COMMIT;
