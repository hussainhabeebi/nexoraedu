/** Examination domain: auto-grading, result computation (EXM-12, EXM-15). */
type Grade = { min: number; grade: string };

export function gradeFor(pct: number, scale: Grade[]) {
  return [...scale].sort((a, b) => b.min - a.min).find((g) => pct >= g.min)?.grade ?? 'F';
}

export function computeResult(marks: number, total: number, pass: number, scale: Grade[]) {
  const percentage = total > 0 ? Math.round((marks / total) * 10000) / 100 : 0;
  return { percentage, grade: gradeFor(percentage, scale), passed: marks >= pass };
}

const norm = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort() : v == null ? [] : [String(v)]);

/** Auto-grade objective questions; returns score and whether manual evaluation is needed. */
export function autoGrade(
  questions: { id: string; type: string; correct: unknown; marks: number; negativeMarks: number }[],
  answers: Record<string, unknown>,
) {
  let score = 0;
  let needsManual = false;
  const breakdown: Record<string, number | null> = {};
  for (const q of questions) {
    const a = answers[q.id];
    if (q.type === 'SHORT' || q.type === 'LONG') {
      needsManual = needsManual || (a != null && String(a).trim() !== '');
      breakdown[q.id] = null;
      continue;
    }
    if (a == null || (Array.isArray(a) && a.length === 0) || a === '') {
      breakdown[q.id] = 0;
      continue;
    }
    const ok = JSON.stringify(norm(a)) === JSON.stringify(norm(q.correct));
    const m = ok ? q.marks : -Math.abs(q.negativeMarks || 0);
    breakdown[q.id] = m;
    score += m;
  }
  return { score: Math.max(0, Math.round(score * 100) / 100), needsManual, breakdown };
}
