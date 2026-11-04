import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import ApplicationForm, { toPayload } from '@/components/ApplicationForm';
import { PageHeader } from '@/components/ui';

export default function StudentNew() {
  const nav = useNavigate();
  return (
    <div>
      <PageHeader title="Register student" subtitle="Direct registration — creates the Student ID, portal login and fee plan immediately." />
      <div className="card p-5 sm:p-8">
        <ApplicationForm mode="staff" requireBatch submitLabel="Register student" onSubmit={async (a) => {
          const r = await api<{ id: string }>('/students', { body: { data: toPayload(a) } });
          toast.success('Student registered — welcome message sent');
          nav(`/staff/students/${r.id}`);
        }} />
      </div>
    </div>
  );
}
