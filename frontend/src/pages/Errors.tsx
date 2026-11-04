import { Link } from 'react-router-dom';
import { Lock, SearchX } from 'lucide-react';

function ErrorPage({ icon, code, title, text }: { icon: React.ReactNode; code: string; title: string; text: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 rounded-2xl bg-brand-50 p-4 text-brand-600">{icon}</div>
      <p className="text-sm font-semibold text-brand-600">{code}</p>
      <h1 className="mt-1 text-2xl font-bold">{title}</h1>
      <p className="mt-2 max-w-md text-slate-500">{text}</p>
      <div className="mt-6 flex gap-2">
        <button className="btn-secondary" onClick={() => history.back()}>Go back</button>
        <Link to="/" className="btn-primary">Home</Link>
      </div>
    </div>
  );
}
export const NotFound = () => <ErrorPage icon={<SearchX className="h-7 w-7" />} code="404" title="Page not found" text="The page you’re looking for doesn’t exist or may have moved." />;
export const Forbidden = () => <ErrorPage icon={<Lock className="h-7 w-7" />} code="403" title="No access" text="Your role doesn’t include access to this page. Contact your administrator if you need it." />;
