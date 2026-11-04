import { useState } from 'react';

/**
 * Nexora Academy logo. Uses the official artwork at /logo.png (frontend/public/logo.png).
 * Falls back to a simple mark if the file is missing. On dark backgrounds (`light`), the
 * navy logo sits on a white chip so it stays legible.
 */
export default function Logo({ light = false, compact = false }: { light?: boolean; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!failed)
    return (
      <span className={light ? 'inline-flex rounded-xl bg-white px-2 py-1' : 'inline-flex'}>
        <img
          src="/logo.png"
          alt="Nexora Academy — An ISO 9001:2015 certified institute"
          className={compact ? 'h-8 w-auto' : 'h-11 w-auto'}
          onError={() => setFailed(true)}
        />
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 64 64" className="h-8 w-8 shrink-0" aria-hidden>
        <circle cx="32" cy="32" r="32" fill="#1e3a8a" />
        <path d="M20 46V18h6l12 16V18h6v28h-6L26 30v16z" fill="#f97316" />
      </svg>
      {!compact && (
        <span className={`font-display text-lg font-extrabold tracking-tight ${light ? 'text-white' : 'text-[#1e3a8a]'}`}>
          NEXORA<span className="font-semibold text-orange-500"> ACADEMY</span>
        </span>
      )}
    </span>
  );
}
