import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Course {
  id: string; code: string; name: string; slug: string; category?: string; summary?: string; description?: string; durationMonths: number; eligibility?: string; mode: string;
  imageUrl?: string; highlights: string[]; defaultInstallments: number; totalFee: number; feeComponents: { name: string; amount: string; taxPercent: string }[];
  batches: { id: string; code: string; name: string; startDate: string; timing?: string; mode: string; capacity: number; status: string; seatsLeft: number }[];
  subjects?: { name: string; hours: number; modules: { name: string }[] }[];
}
export interface Site {
  academy: { name: string; tagline: string; email: string; phone: string; whatsapp: string; address: string; logoUrl: string; currency: string };
  courses: Course[];
  documentTypes: { code: string; label: string; meta?: { mandatory?: boolean } }[];
  qualifications: { code: string; label: string }[];
  stats: { students: number; courses: number };
}
export const useSite = () => useQuery({ queryKey: ['site'], queryFn: () => api<Site>('/public/site'), staleTime: 5 * 60_000 });
export const waLink = (phone: string, text = 'Hi Nexora Academy, I would like to know more about your courses.') => `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
