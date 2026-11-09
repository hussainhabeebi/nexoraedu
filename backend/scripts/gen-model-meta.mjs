/**
 * Writes src/generated/model-meta.json from prisma/schema.prisma: for every model its table, columns, types,
 * defaults, unique keys and relations. Used by lib/db.ts to turn queued writes into SQL for one atomic D1 batch.
 * Run automatically by `npm run generate`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = readFileSync('prisma/schema.prisma', 'utf8');
const enums = new Set([...src.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]));
const modelNames = new Set([...src.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]));
const models = {};
for (const m of src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const [, name, body] = m;
  const model = { table: name, fields: {}, uniques: [], id: [] };
  for (let line of body.split('\n')) {
    line = line.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('@@map(')) { model.table = line.match(/@@map\("([^"]+)"\)/)[1]; continue; }
    if (line.startsWith('@@unique(') || line.startsWith('@@id(')) {
      const cols = line.match(/\[([^\]]+)\]/)[1].split(',').map((s) => s.trim());
      const nameM = line.match(/name:\s*"(\w+)"/);
      (line.startsWith('@@id(') ? model.id = cols : model.uniques.push({ name: nameM?.[1] ?? cols.join('_'), fields: cols }));
      if (line.startsWith('@@id(')) model.uniques.push({ name: nameM?.[1] ?? cols.join('_'), fields: cols });
      continue;
    }
    if (line.startsWith('@@')) continue;
    const fm = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
    if (!fm) continue;
    const [, fname, type, list, opt, attrs] = fm;
    const f = { type, optional: !!opt, list: !!list };
    if (modelNames.has(type)) {
      f.kind = 'relation';
      const r = attrs.match(/@relation\(([^)]*)\)/);
      if (r && /fields:/.test(r[1])) {
        f.fields = r[1].match(/fields:\s*\[([^\]]+)\]/)[1].split(',').map((s) => s.trim());
        f.references = r[1].match(/references:\s*\[([^\]]+)\]/)[1].split(',').map((s) => s.trim());
      }
      const rn = r?.[1].match(/^\s*"(\w+)"|name:\s*"(\w+)"/);
      if (rn) f.relationName = rn[1] ?? rn[2];
    } else {
      f.kind = enums.has(type) ? 'enum' : 'scalar';
      const col = attrs.match(/@map\("([^"]+)"\)/);
      f.column = col ? col[1] : fname;
      if (/@id\b/.test(attrs)) { model.id = [fname]; f.id = true; }
      if (/@unique\b/.test(attrs)) model.uniques.push({ name: fname, fields: [fname] });
      if (/@updatedAt\b/.test(attrs)) f.updatedAt = true;
      const d = attrs.match(/@default\(((?:[^()]|\([^()]*\))*)\)/);
      if (d) f.default = d[1];
    }
    model.fields[fname] = f;
  }
  models[name] = model;
}
mkdirSync('src/generated', { recursive: true });
writeFileSync('src/generated/model-meta.json', JSON.stringify(models));
console.log(`model-meta: ${Object.keys(models).length} models`);
