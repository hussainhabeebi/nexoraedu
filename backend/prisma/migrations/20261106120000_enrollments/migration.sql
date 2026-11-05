-- AlterTable
ALTER TABLE "attendance" ADD COLUMN     "enrollmentId" TEXT;

-- AlterTable
ALTER TABLE "fee_plans" ADD COLUMN     "enrollmentId" TEXT;

-- CreateTable
CREATE TABLE "enrollments" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "batchId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "source" TEXT NOT NULL,
    "applicationId" TEXT,
    "approvalRequestId" TEXT,
    "previousEnrollmentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrollments_studentId_startDate_idx" ON "enrollments"("studentId", "startDate");

-- CreateIndex
CREATE INDEX "enrollments_batchId_status_idx" ON "enrollments"("batchId", "status");

-- CreateIndex
CREATE INDEX "enrollments_courseId_idx" ON "enrollments"("courseId");

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_previousEnrollmentId_fkey" FOREIGN KEY ("previousEnrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written: integrity rules ──
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_status_check"
  CHECK ("status" IN ('ACTIVE', 'ON_HOLD', 'COMPLETED', 'TRANSFERRED', 'WITHDRAWN', 'TERMINATED', 'CANCELLED'));
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_source_check"
  CHECK ("source" IN ('ADMISSION', 'DIRECT', 'TRANSFER', 'COURSE_CHANGE', 'REACTIVATION', 'BACKFILL'));
-- Closed enrollments carry an end date; current ones do not. End is never before start.
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_end_check"
  CHECK ((("status" IN ('ACTIVE', 'ON_HOLD')) = ("endedAt" IS NULL)) AND ("endedAt" IS NULL OR "endedAt" >= "startDate"));
-- At most one CURRENT enrollment per student (existing model: one current course/batch per student).
CREATE UNIQUE INDEX "enrollments_one_current_per_student" ON "enrollments"("studentId") WHERE "status" IN ('ACTIVE', 'ON_HOLD');

-- ── Hand-written: backfill (one enrollment per existing student; no student/finance value is changed) ──
INSERT INTO "enrollments" ("id", "studentId", "courseId", "batchId", "status", "startDate", "endedAt", "endReason", "source", "applicationId", "createdAt", "updatedAt")
SELECT 'enr_' || s."id", s."id", s."courseId", s."batchId",
       CASE s."status" WHEN 'ON_HOLD' THEN 'ON_HOLD' WHEN 'COMPLETED' THEN 'COMPLETED' WHEN 'WITHDRAWN' THEN 'WITHDRAWN' WHEN 'TERMINATED' THEN 'TERMINATED' ELSE 'ACTIVE' END,
       s."admissionDate",
       CASE WHEN s."status" IN ('COMPLETED', 'WITHDRAWN', 'TERMINATED') THEN GREATEST(s."updatedAt", s."admissionDate") END,
       CASE WHEN s."status" IN ('COMPLETED', 'WITHDRAWN', 'TERMINATED') THEN 'Backfilled from student status ' || s."status" END,
       'BACKFILL',
       (SELECT a."id" FROM "applications" a WHERE a."studentId" = s."id" ORDER BY a."createdAt" DESC LIMIT 1),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "students" s;

-- Fee plans of the same course belong to the backfilled enrollment (plans of an earlier course stay NULL).
UPDATE "fee_plans" fp SET "enrollmentId" = e."id"
FROM "enrollments" e WHERE e."id" = 'enr_' || fp."studentId" AND e."courseId" = fp."courseId";

-- Attendance in the student's current batch belongs to the backfilled enrollment. Attendance from batches the
-- student left earlier cannot be attributed reliably and stays NULL (it remains linked to student and session).
UPDATE "attendance" a SET "enrollmentId" = e."id"
FROM "enrollments" e, "timetable_sessions" t
WHERE e."id" = 'enr_' || a."studentId" AND t."id" = a."sessionId" AND e."batchId" = t."batchId";
