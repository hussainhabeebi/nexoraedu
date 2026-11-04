import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3 } from 'lucide-react';
import { cx, Empty, Spinner } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
  hideable?: boolean;
}

/** Table with sorting, pagination, column show/hide, sticky header and bulk selection (UI-14/15). */
export function DataTable<T extends { id: string }>({
  columns, rows, loading, total, page, pageSize = 20, onPage, sort, onSort, selectable, selected, onSelect, empty, onRowClick, toolbar,
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  total?: number;
  page?: number;
  pageSize?: number;
  onPage?: (p: number) => void;
  sort?: { key: string; dir: 'asc' | 'desc' };
  onSort?: (s: { key: string; dir: 'asc' | 'desc' }) => void;
  selectable?: boolean;
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  empty?: ReactNode;
  onRowClick?: (r: T) => void;
  toolbar?: ReactNode;
}) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [colMenu, setColMenu] = useState(false);
  const cols = columns.filter((c) => !hidden.includes(c.key));
  const allSel = selectable && rows.length > 0 && rows.every((r) => selected?.includes(r.id));
  const pages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  return (
    <div className="card overflow-hidden">
      {(toolbar || columns.some((c) => c.hideable)) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <div className="flex flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {columns.some((c) => c.hideable) && (
            <div className="relative">
              <button className="btn-ghost btn-sm" onClick={() => setColMenu((v) => !v)} aria-expanded={colMenu}>
                <Columns3 className="h-4 w-4" /> Columns
              </button>
              {colMenu && (
                <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
                  {columns.filter((c) => c.hideable).map((c) => (
                    <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                      <input type="checkbox" className="rounded text-brand-600" checked={!hidden.includes(c.key)} onChange={() => setHidden((h) => (h.includes(c.key) ? h.filter((x) => x !== c.key) : [...h, c.key]))} />
                      {c.header}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="max-h-[70vh] overflow-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr>
              {selectable && (
                <th className="th w-10">
                  <input type="checkbox" aria-label="Select all" className="rounded text-brand-600" checked={!!allSel} onChange={() => onSelect?.(allSel ? [] : rows.map((r) => r.id))} />
                </th>
              )}
              {cols.map((c) => (
                <th key={c.key} className={cx('th', c.className)}>
                  {c.sortable && onSort ? (
                    <button className="inline-flex items-center gap-1 uppercase hover:text-slate-800" onClick={() => onSort({ key: c.key, dir: sort?.key === c.key && sort.dir === 'desc' ? 'asc' : 'desc' })}>
                      {c.header}
                      {sort?.key === c.key && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {loading ? (
              <tr>
                <td colSpan={cols.length + 1} className="py-12 text-center">
                  <Spinner className="mx-auto" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={cols.length + 1}>{empty ?? <Empty title="Nothing here yet" />}</td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={cx('transition hover:bg-slate-50/70', onRowClick && 'cursor-pointer', selected?.includes(r.id) && 'bg-brand-50/50')} onClick={() => onRowClick?.(r)}>
                  {selectable && (
                    <td className="td w-10" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Select row" className="rounded text-brand-600" checked={!!selected?.includes(r.id)} onChange={() => onSelect?.(selected?.includes(r.id) ? selected.filter((x) => x !== r.id) : [...(selected ?? []), r.id])} />
                    </td>
                  )}
                  {cols.map((c) => (
                    <td key={c.key} className={cx('td', c.className)}>{c.cell(r)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {total != null && onPage && (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
          <span>
            {total === 0 ? 'No results' : `${((page ?? 1) - 1) * pageSize + 1}–${Math.min(total, (page ?? 1) * pageSize)} of ${total}`}
          </span>
          <div className="flex items-center gap-1">
            <button className="btn-ghost btn-sm" disabled={(page ?? 1) <= 1} onClick={() => onPage((page ?? 1) - 1)} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-2">
              {page} / {pages}
            </span>
            <button className="btn-ghost btn-sm" disabled={(page ?? 1) >= pages} onClick={() => onPage((page ?? 1) + 1)} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
