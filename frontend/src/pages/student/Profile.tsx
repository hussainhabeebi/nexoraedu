import { Link } from 'react-router-dom';
import { useGet } from '@/lib/hooks';
import { d } from '@/lib/format';
import { Avatar, Card, KV, PageHeader, PageLoader } from '@/components/ui';

export default function Profile() {
  const { data, isLoading } = useGet<any>('/portal/me');
  if (isLoading) return <PageLoader />;
  const s = data.student;
  return (
    <div className="space-y-6">
      <PageHeader title="My profile" actions={<Link to="/change-password" className="btn-secondary">Change password</Link>} />
      <Card><div className="flex items-center gap-4"><Avatar name={s.fullName} src={s.photoUrl} size="lg" /><div><p className="text-xl font-bold">{s.fullName}</p><p className="text-sm text-slate-500">{s.studentCode} · {s.course.name}</p></div></div></Card>
      <Card title="Details"><KV items={[['Date of birth', d(s.dob)], ['Gender', s.gender], ['Phone', s.phone], ['Email', s.email], ['Address', s.address], ['Batch', s.batch?.name], ['Admitted', d(s.admissionDate)]]} /></Card>
      <Card title="Guardians">{data.guardians.length ? <KV cols={1} items={data.guardians.map((g: any) => [g.relation, `${g.name} · ${g.phone}`])} /> : <p className="text-sm text-slate-500">None recorded</p>}</Card>
      <p className="text-sm text-slate-500">To correct any details, please contact the academy office.</p>
    </div>
  );
}
