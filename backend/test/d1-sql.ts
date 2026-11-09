/** Splits a migration file into statements (handles CREATE TRIGGER … BEGIN … END;). Test-only helper. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inTrigger = false;
  for (const raw of sql.split('\n')) {
    const line = raw.replace(/^\s*--.*$/, '');
    if (!line.trim() && !cur.length) continue;
    cur.push(line);
    if (/^\s*CREATE TRIGGER/i.test(line)) inTrigger = true;
    const done = inTrigger ? /\bEND;\s*$/i.test(line) : /;\s*$/.test(line);
    if (done) {
      out.push(cur.join('\n').trim());
      cur = [];
      inTrigger = false;
    }
  }
  if (cur.join('').trim()) out.push(cur.join('\n').trim());
  return out;
}
