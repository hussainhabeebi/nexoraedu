import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from './api';

export function useGet<T = any>(path: string | null, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: [path], queryFn: () => api<T>(path!), enabled: !!path, ...opts });
}

/** Mutation with success toast + invalidation of queries whose key starts with any prefix. */
export function useMut<V = any, R = any>(fn: (v: V) => Promise<R>, o: { success?: string | ((r: R) => string); invalidate?: string[]; onSuccess?: (r: R) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<R, Error, V>({
    mutationFn: fn,
    onSuccess: (r) => {
      if (o.success) toast.success(typeof o.success === 'function' ? o.success(r) : o.success);
      o.invalidate?.forEach((p) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith(p) }));
      o.onSuccess?.(r);
    },
    onError: (e) => toast.error(e.message),
  });
}

/**
 * Delete a setup item. The server refuses (with the reason and the alternative, shown as a toast) when the item
 * is in use, so nothing is ever removed that other records depend on.
 */
export function useDelete(label: string, invalidate: string[], onSuccess?: () => void) {
  return useMut((path: string) => api(path, { method: 'DELETE' }), { success: `${label} deleted`, invalidate, onSuccess });
}
export const confirmDelete = (what: string) =>
  window.confirm(`Delete ${what}? This cannot be undone.\n\nIf it is still in use, nothing is deleted and you will be told why.`);

export const useCourses = () => useGet<{ items: any[] }>('/academics/courses', { staleTime: 60_000 });
export const useBatches = (courseId?: string) => useGet<{ items: any[] }>(`/academics/batches${courseId ? `?courseId=${courseId}` : ''}`, { staleTime: 60_000 });
export const useMasters = (type?: string) => useGet<{ items: { id: string; type: string; code: string; label: string; isActive: boolean; meta?: any }[]; types: string[] }>(`/admin/masters${type ? `?type=${type}` : ''}`, { staleTime: 5 * 60_000 });
export const useStaff = (role?: string) => useGet<{ items: any[] }>(`/admin/users?pageSize=200&active=true${role ? `&role=${role}` : ''}`, { staleTime: 60_000, retry: false });
