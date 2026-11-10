/**
 * Atomic writes on Cloudflare D1.
 *
 * D1 has no interactive transactions, but a D1 batch() runs all its statements in ONE transaction: either
 * every statement commits or none does. atomic() gives the code a `tx` object that looks like the Prisma client:
 *
 *   - READS (findUnique, findMany, count, aggregate, $queryRaw …) go straight to the database. They see the
 *     data as it was before this batch; they do not see the batch's own queued writes.
 *   - WRITES (create, update, upsert, delete, … , $executeRaw) are queued and sent together as one batch
 *     when the callback returns. create() returns the new row (ids and defaults are filled in up front).
 *
 * Concurrency (replaces SELECT … FOR UPDATE):
 *   - tx.lock(key) takes an optimistic lock: if another batch with the same key commits first, this batch is
 *     rejected and the whole callback is re-run with fresh reads (up to MAX_ATTEMPTS).
 *   - update/delete of one row and updateMany/deleteMany check at commit time that they changed exactly the rows
 *     they changed when the callback ran (compare-and-set), otherwise the batch is retried in the same way.
 *   - tx.assert(condition) aborts the batch with a message when a SQL condition is not true at commit time.
 *
 * Database rules (CHECK, UNIQUE, append-only triggers in migrations/0002_rules.sql) are enforced inside the
 * batch, so a batch that breaks any rule is rolled back as a whole.
 */
import meta from '../generated/model-meta.json';
import { Prisma } from '#prisma';
import { d1, prisma } from './prisma';
import { afterCommitQueue } from './background';

type Field = { type: string; optional: boolean; list: boolean; kind: 'scalar' | 'enum' | 'relation'; column?: string; id?: boolean; updatedAt?: boolean; default?: string; fields?: string[]; references?: string[]; relationName?: string };
type Model = { table: string; fields: Record<string, Field>; uniques: { name: string; fields: string[] }[]; id: string[] };
type Row = Record<string, any>;
type Stmt = { sql: string; params: unknown[] };

const MODELS = meta as unknown as Record<string, Model>;
const DELEGATES: Record<string, string> = Object.fromEntries(Object.keys(MODELS).map((m) => [m[0].toLowerCase() + m.slice(1), m]));
const MAX_ATTEMPTS = 12;
const CONFLICT = 'NEXORA_CONFLICT';

/** Same text format Prisma uses for DateTime in SQLite, so comparisons in SQL stay correct. */
/** Table and column names of a Prisma model/field (from the schema), for hand-written SQL checks. */
export function sqlName(modelName: string, field?: string): string {
  const m = MODELS[modelName];
  if (!m) throw new Error(`Unknown model ${modelName}`);
  if (!field) return `"${m.table}"`;
  const f = m.fields[field];
  if (!f || f.kind === 'relation') throw new Error(`Unknown column ${modelName}.${field}`);
  return `"${f.column ?? field}"`;
}

export const dbDate = (d: Date | string | number) => new Date(d).toISOString().replace('Z', '+00:00');
/** Money and percentages: 2 decimals (the database rejects anything else). */
export const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

let idCounter = 0;
/** Collision-resistant id in the same style as Prisma's cuid(). */
export function newId() {
  const rnd = crypto.getRandomValues(new Uint8Array(10));
  idCounter = (idCounter + 1) % 1296;
  return 'c' + Date.now().toString(36) + idCounter.toString(36).padStart(2, '0') + Array.from(rnd, (b) => (b % 36).toString(36)).join('');
}

const q = (name: string) => `"${name}"`;
const col = (f: Field, name: string) => q(f.column ?? name);

function encode(f: Field, v: any): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  switch (f.type) {
    case 'DateTime': return dbDate(v);
    case 'Json': return JSON.stringify(v);
    case 'Boolean': return v ? 1 : 0;
    case 'Decimal': return round2(Number(v));
    case 'Int': return Number(v);
    case 'Float': return Number(v);
    default: return v;
  }
}
function decode(f: Field, v: any): unknown {
  if (v === undefined || v === null) return v;
  switch (f.type) {
    case 'DateTime': return v instanceof Date ? v : new Date(v);
    case 'Decimal': return new Prisma.Decimal(round2(Number(v)));
    default: return v;
  }
}

function defaultValue(f: Field): unknown {
  const d = f.default!;
  if (d === 'cuid()' || d === 'uuid()' || d === 'cuid(2)') return newId();
  if (d === 'now()') return new Date();
  if (d === 'true' || d === 'false') return d === 'true';
  if (/^-?\d+(\.\d+)?$/.test(d)) return Number(d);
  if (d.startsWith('"')) {
    const s = JSON.parse(d);
    return f.type === 'Json' ? JSON.parse(s) : s;
  }
  if (d.startsWith('dbgenerated') || d === 'autoincrement()') return undefined;
  return d; // enum literal
}

function model(name: string): Model {
  const m = MODELS[name];
  if (!m) throw new Error(`Unknown model ${name}`);
  return m;
}

/** WHERE clause for the subset of Prisma filters the ERP uses on writes. */
function where(m: Model, w: Row | undefined, alias = ''): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const p = alias ? `${alias}.` : '';
  for (const [k, v] of Object.entries(w ?? {})) {
    if (v === undefined) continue;
    if (k === 'AND' || k === 'OR') {
      const list = (Array.isArray(v) ? v : [v]).map((x) => where(m, x, alias));
      if (!list.length) continue;
      parts.push(`(${list.map((x) => `(${x.sql})`).join(k === 'AND' ? ' AND ' : ' OR ')})`);
      list.forEach((x) => params.push(...x.params));
      continue;
    }
    if (k === 'NOT') {
      const x = where(m, v, alias);
      parts.push(`NOT (${x.sql})`);
      params.push(...x.params);
      continue;
    }
    const compound = m.uniques.find((u) => u.name === k && u.fields.length > 1);
    if (compound) {
      const x = where(m, v, alias);
      parts.push(x.sql);
      params.push(...x.params);
      continue;
    }
    const f = m.fields[k];
    if (!f || f.kind === 'relation') throw new Error(`atomic(): unsupported filter "${k}" on ${m.table}`);
    const c = p + col(f, k);
    if (v === null) { parts.push(`${c} IS NULL`); continue; }
    if (typeof v !== 'object' || v instanceof Date || Prisma.Decimal.isDecimal(v)) { parts.push(`${c} = ?`); params.push(encode(f, v)); continue; }
    for (const [op, x] of Object.entries(v as Row)) {
      if (x === undefined) continue;
      switch (op) {
        case 'equals': if (x === null) parts.push(`${c} IS NULL`); else { parts.push(`${c} = ?`); params.push(encode(f, x)); } break;
        case 'not': if (x === null) parts.push(`${c} IS NOT NULL`); else { parts.push(`(${c} IS NULL OR ${c} <> ?)`); params.push(encode(f, x)); } break;
        case 'in': case 'notIn': {
          const arr = x as unknown[];
          if (!arr.length) { parts.push(op === 'in' ? '0' : '1'); break; }
          parts.push(`${c} ${op === 'in' ? 'IN' : 'NOT IN'} (${arr.map(() => '?').join(', ')})`);
          params.push(...arr.map((y) => encode(f, y)));
          break;
        }
        case 'lt': case 'lte': case 'gt': case 'gte':
          parts.push(`${c} ${{ lt: '<', lte: '<=', gt: '>', gte: '>=' }[op]} ?`); params.push(encode(f, x)); break;
        default: throw new Error(`atomic(): unsupported operator "${op}" on ${m.table}.${k}`);
      }
    }
  }
  return { sql: parts.length ? parts.join(' AND ') : '1', params };
}

/** Error that looks like Prisma's, so the existing error handler maps it (409 duplicate, 404 not found). */
function prismaError(message: string, code: string, metaInfo?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client, meta: metaInfo });
}
export function translateD1Error(e: unknown): unknown {
  const msg = String((e as any)?.message ?? e);
  const uniq = msg.match(/UNIQUE constraint failed: ([\w.", ]+)/);
  if (uniq) return prismaError(msg, 'P2002', { target: uniq[1].split(',').map((s) => s.trim().split('.').pop()!.replace(/"/g, '')) });
  return e;
}

/** Read-only database access: the Prisma client or an atomic() `tx` (reads only). */
export type ReadDb = Omit<typeof prisma, '$transaction'>;

export type Tx = Omit<typeof prisma, '$transaction'> & {
  /** Optimistic lock on a business key (e.g. `feeplan:<id>`); see module comment. */
  lock(key: string): Promise<void>;
  /** Abort the batch with `message` unless the SQL condition (a scalar expression) is true at commit time. */
  assert(conditionSql: string, params: unknown[], message: string): void;
  /** Run after a successful commit (e.g. notifications). */
  afterCommit(fn: () => unknown): void;
};

class Batch {
  stmts: Stmt[] = [];
  locks: Stmt[] = [];
  lockKeys = new Set<string>();
  lockVersions = new Map<string, number>();

  /** True when another batch committed under one of our locks after we read it (our reads may be stale). */
  async locksMoved(): Promise<boolean> {
    for (const [k, v] of this.lockVersions) {
      const r = await d1().prepare(`SELECT version FROM "_locks" WHERE key = ?`).bind(k).first<{ version: number }>();
      if ((r?.version ?? 0) !== v) return true;
    }
    return false;
  }
  after: (() => unknown)[] = [];
  /** Rows created by this batch (not yet in the database), so later steps of the same operation can find them. */
  created = new Map<string, Row[]>();
  /** After-state of rows updated (or null when deleted) by this batch, keyed by model and primary key. */
  changed = new Map<string, Map<string, Row | null>>();

  keyOf(modelName: string, row: Row) {
    return JSON.stringify(model(modelName).id.map((c) => row[c]));
  }
  recordChange(modelName: string, row: Row, after: Row | null) {
    if (!this.changed.has(modelName)) this.changed.set(modelName, new Map());
    this.changed.get(modelName)!.set(this.keyOf(modelName, row), after);
  }
  /** Rows as this batch will leave them: updated rows replaced, deleted rows removed, rows that no longer match dropped. */
  overlay(modelName: string, rows: Row[], w: Row | undefined): Row[] {
    const ch = this.changed.get(modelName);
    if (!ch?.size) return rows;
    const m = model(modelName);
    const out: Row[] = [];
    for (const r of rows) {
      const k = this.keyOf(modelName, r);
      if (!ch.has(k)) { out.push(r); continue; }
      const after = ch.get(k);
      if (!after) continue; // deleted in this batch
      const merged = { ...r, ...Object.fromEntries(Object.entries(after).filter(([f]) => f in r)) };
      if (matches3(m, after, w ?? {}) === false) continue;
      out.push(merged);
    }
    return out;
  }

  pendingMatch(modelName: string, w: Row | undefined): Row | undefined {
    return (this.created.get(modelName) ?? []).find((r) => matches(model(modelName), r, w ?? {}));
  }

  push(sql: string, params: unknown[] = []) {
    this.stmts.push({ sql, params: params.map((p) => (p === undefined ? null : p)) });
  }
  expectChanges(n: number, what: string) {
    this.push(`INSERT INTO "_assert" (ok, msg) VALUES ((SELECT changes() = ?), ?)`, [n, `${CONFLICT}: ${what} changed concurrently`]);
  }

  /** INSERT a row (and nested to-many `create`s); returns the row as Prisma would, without relations. */
  insert(modelName: string, data: Row): Row {
    const m = model(modelName);
    const row: Row = {};
    const children: { model: string; fk: Record<string, string>; rows: Row[] }[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = m.fields[k];
      if (!f) throw new Error(`atomic(): unknown field ${modelName}.${k}`);
      if (f.kind !== 'relation') { row[k] = v; continue; }
      const rel = v as Row;
      if (rel.connect && f.fields) { f.fields.forEach((fk, i) => (row[fk] = rel.connect[f.references![i]])); continue; }
      if ((rel.create || rel.createMany) && f.list) {
        const child = model(f.type);
        const back = Object.entries(child.fields).find(([, cf]) => cf.kind === 'relation' && cf.type === modelName && cf.fields && (!f.relationName || cf.relationName === f.relationName));
        if (!back) throw new Error(`atomic(): cannot find relation ${f.type} → ${modelName}`);
        const fk = Object.fromEntries(back[1].fields!.map((x, i) => [x, back[1].references![i]]));
        const rows = rel.createMany ? rel.createMany.data : Array.isArray(rel.create) ? rel.create : [rel.create];
        children.push({ model: f.type, fk, rows });
        continue;
      }
      if (rel.create && f.fields) {
        const created = this.insert(f.type, rel.create);
        f.fields.forEach((fk, i) => (row[fk] = created[f.references![i]]));
        continue;
      }
      throw new Error(`atomic(): unsupported nested write on ${modelName}.${k}`);
    }
    for (const [k, f] of Object.entries(m.fields)) {
      if (f.kind === 'relation' || row[k] !== undefined) continue;
      if (f.default !== undefined) row[k] = defaultValue(f);
      else if (f.updatedAt) row[k] = new Date();
      else if (f.optional) row[k] = null;
    }
    const cols = Object.keys(row).filter((k) => row[k] !== undefined);
    this.push(`INSERT INTO ${q(m.table)} (${cols.map((k) => col(m.fields[k], k)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((k) => encode(m.fields[k], row[k])));
    for (const c of children) for (const r of c.rows) this.insert(c.model, { ...Object.fromEntries(Object.entries(c.fk).map(([x, ref]) => [x, row[ref]])), ...r });
    const out = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, decode(m.fields[k], v)]));
    if (!this.created.has(modelName)) this.created.set(modelName, []);
    this.created.get(modelName)!.push(out);
    return out;
  }

  /**
   * Nested writes on to-many relations inside update(): { deleteMany, create, createMany }. Queued after the
   * parent UPDATE; returns the data without those keys.
   */
  nestedListWrites(modelName: string, parent: Row, data: Row): { rest: Row; run: () => void } {
    const m = model(modelName);
    const rest: Row = {};
    const jobs: (() => void)[] = [];
    for (const [k, v] of Object.entries(data)) {
      const f = m.fields[k];
      if (!f || f.kind !== 'relation' || !f.list || !v || typeof v !== 'object') { rest[k] = v; continue; }
      const child = model(f.type);
      const back = Object.entries(child.fields).find(([, cf]) => cf.kind === 'relation' && cf.type === modelName && cf.fields && (!f.relationName || cf.relationName === f.relationName));
      if (!back) throw new Error(`atomic(): cannot find relation ${f.type} → ${modelName}`);
      const fk = Object.fromEntries(back[1].fields!.map((x, i) => [x, parent[back[1].references![i]]]));
      for (const [op, arg] of Object.entries(v as Row)) {
        if (op === 'deleteMany') jobs.push(() => { const w = where(child, { ...(arg === true ? {} : arg), ...fk }); this.push(`DELETE FROM ${q(child.table)} WHERE ${w.sql}`, w.params); });
        else if (op === 'create' || op === 'createMany') {
          const rows = op === 'createMany' ? arg.data : Array.isArray(arg) ? arg : [arg];
          jobs.push(() => rows.forEach((r: Row) => this.insert(f.type, { ...fk, ...r })));
        } else throw new Error(`atomic(): unsupported nested ${op} on ${modelName}.${k}`);
      }
    }
    return { rest, run: () => jobs.forEach((j) => j()) };
  }

  /** SET clause from Prisma update data (values, set/increment/decrement/multiply, connect/disconnect). */
  setClause(m: Model, data: Row): { sql: string; params: unknown[]; applied: Row } {
    const sets: string[] = [];
    const params: unknown[] = [];
    const applied: Row = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = m.fields[k];
      if (!f) throw new Error(`atomic(): unknown field ${m.table}.${k}`);
      if (f.kind === 'relation') {
        if (v?.connect && f.fields) { f.fields.forEach((fk, i) => { sets.push(`${col(m.fields[fk], fk)} = ?`); params.push(encode(m.fields[fk], v.connect[f.references![i]])); applied[fk] = v.connect[f.references![i]]; }); continue; }
        if (v?.disconnect && f.fields) { f.fields.forEach((fk) => { sets.push(`${col(m.fields[fk], fk)} = NULL`); applied[fk] = null; }); continue; }
        throw new Error(`atomic(): unsupported nested update on ${m.table}.${k}`);
      }
      const c = col(f, k);
      const isObj = v !== null && typeof v === 'object' && !(v instanceof Date) && !Prisma.Decimal.isDecimal(v) && f.type !== 'Json';
      if (isObj && 'set' in v) { sets.push(`${c} = ?`); params.push(encode(f, v.set)); applied[k] = v.set; continue; }
      if (isObj) {
        const [op, x] = Object.entries(v)[0] as [string, number];
        const sym = { increment: '+', decrement: '-', multiply: '*', divide: '/' }[op];
        if (!sym) throw new Error(`atomic(): unsupported update operator ${op}`);
        sets.push(f.type === 'Decimal' ? `${c} = round(${c} ${sym} ?, 2)` : `${c} = ${c} ${sym} ?`);
        params.push(Number(x));
        applied[k] = { [op]: Number(x) };
        continue;
      }
      sets.push(`${c} = ?`);
      params.push(encode(f, v));
      applied[k] = v;
    }
    for (const [k, f] of Object.entries(m.fields)) if (f.updatedAt && data[k] === undefined) { sets.push(`${col(f, k)} = ?`); params.push(dbDate(new Date())); applied[k] = new Date(); }
    return { sql: sets.join(', '), params, applied };
  }
}

/** Apply queued update data to a row read before the batch, to return what Prisma's update() would return. */
function merge(m: Model, before: Row, applied: Row): Row {
  const out = { ...before };
  for (const [k, v] of Object.entries(applied)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && m.fields[k]?.type !== 'Json' && ('increment' in v || 'decrement' in v || 'multiply' in v || 'divide' in v)) {
      const cur = Number(before[k] ?? 0);
      const n = 'increment' in v ? v.increment : -v.decrement;
      const val = 'multiply' in v ? cur * v.multiply : 'divide' in v ? cur / v.divide : cur + n;
      out[k] = decode(m.fields[k], m.fields[k].type === 'Decimal' ? round2(val) : val);
    } else out[k] = decode(m.fields[k], v);
  }
  return out;
}

function sqlOf(strings: TemplateStringsArray | Prisma.Sql, values: unknown[]): Stmt {
  if (strings instanceof Prisma.Sql) return { sql: strings.sql, params: strings.values };
  const s = Prisma.sql(strings, ...values);
  return { sql: s.sql, params: s.values };
}

function makeTx(b: Batch): Tx {
  const delegate = (modelName: string, read: any) => {
    const m = model(modelName);
    const uniqueRow = async (w: Row, verb: string) => {
      const before = (await read.findUnique({ where: w })) ?? b.pendingMatch(modelName, w);
      if (!before) throw prismaError(`No record found to ${verb} in ${m.table}.`, 'P2025');
      return before;
    };
    const noShape = (_args: Row, _verb: string) => {};
    /** `include` on a write: related rows are read from the database or from rows created in this batch. */
    const withIncludes = async (row: Row, include?: Row) => {
      if (!include) return row;
      const out = { ...row };
      for (const [k, spec] of Object.entries(include)) {
        if (!spec) continue;
        const f = m.fields[k];
        if (!f || f.kind !== 'relation') throw new Error(`atomic(): cannot include ${modelName}.${k}`);
        const nested = typeof spec === 'object' ? spec : {};
        const relRead = (prisma as any)[f.type[0].toLowerCase() + f.type.slice(1)];
        if (f.fields) {
          const w = Object.fromEntries(f.references!.map((ref, i) => [ref, row[f.fields![i]]]));
          if (Object.values(w).some((x) => x == null)) { out[k] = null; continue; }
          out[k] = (await relRead.findFirst({ where: w, ...nested })) ?? b.pendingMatch(f.type, w) ?? null;
        } else {
          const child = model(f.type);
          const back = Object.entries(child.fields).find(([, cf]) => cf.kind === 'relation' && cf.type === modelName && cf.fields && (!f.relationName || cf.relationName === f.relationName))!;
          const w = Object.fromEntries(back[1].fields!.map((x, i) => [x, row[back[1].references![i]]]));
          const fromDb = await relRead.findMany({ where: w, ...nested });
          const ids = new Set(fromDb.map((x: Row) => JSON.stringify(child.id.map((c) => x[c]))));
          out[k] = f.list ? [...fromDb, ...(b.created.get(f.type) ?? []).filter((r) => matches(child, r, w) && !ids.has(JSON.stringify(child.id.map((c) => r[c]))))] : fromDb[0] ?? null;
        }
      }
      return out;
    };
    return new Proxy(read, {
      get(target, op: string) {
        switch (op) {
          case 'create':
            return async (args: Row) => withIncludes(b.insert(modelName, args.data), args.include);
          case 'createMany':
            return async (args: Row) => { const rows = Array.isArray(args.data) ? args.data : [args.data]; rows.forEach((r: Row) => b.insert(modelName, r)); return { count: rows.length }; };
          case 'update':
            return async (args: Row) => {
              noShape(args, op);
              const before = await uniqueRow(args.where, 'update');
              const nested = b.nestedListWrites(modelName, before, args.data);
              const s = b.setClause(m, nested.rest);
              const w = where(m, args.where);
              b.push(`UPDATE ${q(m.table)} SET ${s.sql} WHERE ${w.sql}`, [...s.params, ...w.params]);
              b.expectChanges(1, `${m.table} row`);
              nested.run();
              const after = merge(m, before, s.applied);
              const pending = b.pendingMatch(modelName, args.where);
              if (pending) Object.assign(pending, after);
              b.recordChange(modelName, before, after);
              return withIncludes(after, args.include);
            };
          case 'updateMany':
            return async (args: Row) => {
              const rows: Row[] = b.overlay(modelName, await read.findMany({ where: args.where }), args.where);
              const count = rows.length;
              const s = b.setClause(m, args.data);
              const w = where(m, args.where);
              if (s.sql) b.push(`UPDATE ${q(m.table)} SET ${s.sql} WHERE ${w.sql}`, [...s.params, ...w.params]);
              b.expectChanges(count, `${m.table} rows`);
              for (const r of rows) b.recordChange(modelName, r, merge(m, r, s.applied));
              return { count };
            };
          case 'upsert':
            return async (args: Row) => {
              noShape(args, op);
              const before = (await read.findUnique({ where: args.where })) ?? b.pendingMatch(modelName, args.where);
              if (!before) return b.insert(modelName, { ...flatWhere(m, args.where), ...args.create });
              const s = b.setClause(m, args.update);
              const w = where(m, args.where);
              if (s.sql) { b.push(`UPDATE ${q(m.table)} SET ${s.sql} WHERE ${w.sql}`, [...s.params, ...w.params]); b.expectChanges(1, `${m.table} row`); }
              return merge(m, before, s.applied);
            };
          case 'delete':
            return async (args: Row) => {
              const before = await uniqueRow(args.where, 'delete');
              const w = where(m, args.where);
              b.push(`DELETE FROM ${q(m.table)} WHERE ${w.sql}`, w.params);
              b.expectChanges(1, `${m.table} row`);
              b.recordChange(modelName, before, null);
              return before;
            };
          case 'deleteMany':
            return async (args: Row = {}) => {
              const rows: Row[] = b.overlay(modelName, await read.findMany({ where: args.where }), args.where);
              const w = where(m, args.where);
              b.push(`DELETE FROM ${q(m.table)} WHERE ${w.sql}`, w.params);
              b.expectChanges(rows.length, `${m.table} rows`);
              for (const r of rows) b.recordChange(modelName, r, null);
              return { count: rows.length };
            };
          case 'findMany':
            // Reads see the database as this batch will leave it: rows it updated/deleted/created are reflected.
            return async (args: Row = {}) => {
              if (!b.changed.get(modelName)?.size && !b.created.get(modelName)?.length) return target.findMany(args);
              const { take, skip, ...rest } = args;
              let rows = b.overlay(modelName, await target.findMany(rest), args.where);
              if (!args.include && !args.select) rows = [...rows, ...(b.created.get(modelName) ?? []).filter((r) => matches3(m, r, args.where ?? {}) === true && !rows.some((x) => b.keyOf(modelName, x) === b.keyOf(modelName, r)))];
              return rows.slice(skip ?? 0, take !== undefined ? (skip ?? 0) + take : undefined);
            };
          case 'count':
            return async (args: Row = {}) => {
              if (!b.changed.get(modelName)?.size && !b.created.get(modelName)?.length) return target.count(args);
              const rows = b.overlay(modelName, await target.findMany({ where: args.where }), args.where);
              return rows.length + (b.created.get(modelName) ?? []).filter((r) => matches3(m, r, args.where ?? {}) === true && !rows.some((x) => b.keyOf(modelName, x) === b.keyOf(modelName, r))).length;
            };
          case 'findUnique': case 'findFirst': case 'findUniqueOrThrow': case 'findFirstOrThrow':
            // Reads see the database; a row created earlier in this same batch is returned too (without relations).
            return async (args: Row = {}) => {
              const base = op.replace('OrThrow', '');
              let fromDb: Row | null;
              if (b.changed.get(modelName)?.size) {
                const { take: _t, ...rest } = args;
                fromDb = b.overlay(modelName, base === 'findUnique' ? [await target.findUnique(rest)].filter(Boolean) : await target.findMany(rest), args.where)[0] ?? null;
              } else fromDb = await (target as any)[base](args);
              if (fromDb) return fromDb;
              const pending = b.pendingMatch(modelName, args.where);
              if (pending) return withIncludes(pending, args.include);
              if (op.endsWith('OrThrow')) throw prismaError(`No ${modelName} found`, 'P2025');
              return null;
            };
          default:
            return (target as any)[op]; // reads
        }
      },
    });
  };
  return new Proxy({} as Tx, {
    get(_t, key: string) {
      if (key === 'lock') return async (k: string) => {
        if (b.lockKeys.has(k)) return;
        b.lockKeys.add(k);
        const r = await d1().prepare(`SELECT version FROM "_locks" WHERE key = ?`).bind(k).first<{ version: number }>();
        const v = r?.version ?? 0;
        b.lockVersions.set(k, v);
        b.locks.push({ sql: `INSERT INTO "_assert" (ok, msg) VALUES ((SELECT coalesce((SELECT version FROM "_locks" WHERE key = ?), 0) = ?), ?)`, params: [k, v, `${CONFLICT}: ${k}`] });
        b.locks.push({ sql: `INSERT INTO "_locks" (key, version) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET version = version + 1`, params: [k] });
      };
      if (key === 'assert') return (cond: string, params: unknown[], message: string) => b.push(`INSERT INTO "_assert" (ok, msg) VALUES ((${cond}), ?)`, [...params, message]);
      if (key === 'afterCommit') return (fn: () => unknown) => b.after.push(fn);
      if (key === '$executeRaw') return async (s: TemplateStringsArray | Prisma.Sql, ...v: unknown[]) => { const x = sqlOf(s, v); b.push(x.sql, x.params); return 0; };
      if (key === '$executeRawUnsafe') return async (sql: string, ...v: unknown[]) => { b.push(sql, v); return 0; };
      if (key === '$queryRaw') return (s: TemplateStringsArray | Prisma.Sql, ...v: unknown[]) => {
        const x = sqlOf(s, v);
        if (/\bFOR\s+UPDATE\b|\bRETURNING\b|^\s*(INSERT|UPDATE|DELETE)/i.test(x.sql)) throw new Error('atomic(): $queryRaw must be read-only; use tx.lock() instead of FOR UPDATE.');
        return (prisma as any).$queryRaw(s, ...v);
      };
      if (key === '$transaction') throw new Error('Nested transactions are not supported.');
      const modelName = DELEGATES[key];
      if (modelName) return delegate(modelName, (prisma as any)[key]);
      return (prisma as any)[key];
    },
  });
}

/** Like matches(), but `null` when a filter cannot be evaluated in memory (caller then trusts the database). */
function matches3(m: Model, row: Row, w: Row): boolean | null {
  let unknown = false;
  for (const [k, v] of Object.entries(w)) {
    if (v === undefined) continue;
    const f = m.fields[k];
    const compound = m.uniques.find((u) => u.name === k && u.fields.length > 1);
    if (compound || k === 'AND') {
      const r = (Array.isArray(v) ? v : [v]).map((x) => matches3(m, row, x));
      if (r.includes(false)) return false;
      if (r.includes(null)) unknown = true;
      continue;
    }
    if (!f || f.kind === 'relation' || k === 'OR' || k === 'NOT') { unknown = true; continue; }
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Prisma.Decimal.isDecimal(v) && Object.keys(v).some((op) => !['equals', 'in', 'not', 'notIn'].includes(op))) { unknown = true; continue; }
    let vv: any = v;
    if (v !== null && typeof v === 'object' && 'notIn' in v) { const { notIn: _n, ...restOps } = v as Row; vv = Object.keys(restOps).length ? restOps : undefined; }
    if (vv !== undefined && !matches(m, row, { [k]: vv })) return false;
    if (v !== null && typeof v === 'object' && 'notIn' in v && (v.notIn as unknown[]).includes(row[k])) return false;
  }
  return unknown ? null : true;
}

/** Simple in-memory match (equality / in / not) used only for rows created in the current batch. */
function matches(m: Model, row: Row, w: Row): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (v === undefined) continue;
    const compound = m.uniques.find((u) => u.name === k && u.fields.length > 1);
    if (compound) { if (!matches(m, row, v)) return false; continue; }
    if (k === 'AND') { if (!(Array.isArray(v) ? v : [v]).every((x) => matches(m, row, x))) return false; continue; }
    if (k === 'OR' || k === 'NOT' || !m.fields[k] || m.fields[k].kind === 'relation') return false;
    const cur = row[k] instanceof Date ? row[k].getTime() : Prisma.Decimal.isDecimal(row[k]) ? Number(row[k]) : row[k];
    const norm = (x: any) => (x instanceof Date ? x.getTime() : Prisma.Decimal.isDecimal(x) ? Number(x) : x);
    if (v === null || typeof v !== 'object' || v instanceof Date || Prisma.Decimal.isDecimal(v)) { if (cur !== norm(v)) return false; continue; }
    if ('equals' in v && cur !== norm(v.equals)) return false;
    if ('in' in v && !(v.in as unknown[]).map(norm).includes(cur)) return false;
    if ('not' in v && cur === norm(v.not)) return false;
    if (Object.keys(v).some((op) => !['equals', 'in', 'not'].includes(op))) return false;
  }
  return true;
}

function flatWhere(m: Model, w: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(w)) {
    const compound = m.uniques.find((u) => u.name === k && u.fields.length > 1);
    if (compound) Object.assign(out, v);
    else if (v === null || typeof v !== 'object' || v instanceof Date) out[k] = v;
  }
  return out;
}

/**
 * Run `fn` with a transaction-like `tx` and commit all its writes as ONE atomic D1 batch.
 * The callback may be run more than once (on a concurrent conflict), so it must not have side effects other
 * than reads and queued writes; use tx.afterCommit() for anything else.
 */
export async function atomic<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const b = new Batch();
    let result: T;
    try {
      result = await afterCommitQueue.run(b.after, () => fn(makeTx(b)));
    } catch (e) {
      // A business check failed on data that a concurrent batch (same lock) changed meanwhile: re-run with fresh
      // reads, so the caller gets the answer for the current state (e.g. "already decided"), not a stale one.
      if (attempt < MAX_ATTEMPTS && (await b.locksMoved())) continue;
      throw e;
    }
    const stmts = [...b.locks, ...b.stmts];
    if (stmts.length) {
      try {
        const db = d1();
        await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
      } catch (e) {
        if (String((e as any)?.message ?? e).includes(CONFLICT) && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, Math.random() * Math.min(200, 5 * 2 ** attempt)));
          continue;
        }
        if (String((e as any)?.message ?? e).includes(CONFLICT)) throw prismaError('The record is busy; please try again.', 'P2034');
        throw translateD1Error(e);
      }
    }
    for (const f of b.after) await f();
    return result;
  }
}

/** Raised from a business check inside atomic() that should simply be retried with fresh data. */
export const conflictMarker = CONFLICT;
