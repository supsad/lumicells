import { useId } from 'react';

/** Pink/red over-ear headphones on a transparent background (the card supplies the blue). */
export function Headphones({ className }: { className?: string }) {
  const uid = useId();
  const band = `${uid}-band`;
  const cup = `${uid}-cup`;
  const cushion = `${uid}-cushion`;
  return (
    <svg
      className={className}
      viewBox="0 0 54 54"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={band} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4f8ff" />
          <stop offset="1" stopColor="#a9c8ff" />
        </linearGradient>
        <linearGradient id={cup} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5a80" />
          <stop offset="1" stopColor="#c8103c" />
        </linearGradient>
        <radialGradient id={cushion} cx="0.4" cy="0.35" r="0.8">
          <stop offset="0" stopColor="#ff4a74" />
          <stop offset="1" stopColor="#b80c38" />
        </radialGradient>
      </defs>
      {/* soft contact shadow under the cups */}
      <ellipse cx="28" cy="47.5" rx="15" ry="2" fill="#03235e" opacity="0.28" />
      {/* headband */}
      <path
        d="M9.6 34 C5.6 15 15.5 5.2 27 5.2 C38 5.2 43.4 13.5 43.8 29"
        fill="none"
        stroke={`url(#${band})`}
        strokeWidth="3.1"
        strokeLinecap="round"
      />
      <path
        d="M11.6 30 C9.4 16.5 17 8 27 8 C36 8 40.4 14.5 41 26"
        fill="none"
        stroke="#ffffff"
        strokeWidth="0.9"
        strokeLinecap="round"
        opacity="0.55"
      />
      {/* left cup: leaning oval */}
      <g transform="rotate(-16 19.5 36)">
        <ellipse cx="19.5" cy="36" rx="7.6" ry="10.6" fill="#ffd1df" />
        <ellipse cx="19.2" cy="36.2" rx="6.4" ry="9.6" fill={`url(#${cup})`} />
        <ellipse cx="19.3" cy="36.4" rx="4" ry="7" fill={`url(#${cushion})`} />
        <ellipse cx="17.6" cy="31.5" rx="1.6" ry="3" fill="#ffffff" opacity="0.28" />
      </g>
      {/* right cup: narrow, seen from the side */}
      <g transform="rotate(17 36.6 35.6)">
        <ellipse cx="36.6" cy="35.6" rx="4.4" ry="11" fill="#ffd9e6" />
        <ellipse cx="35.6" cy="35.6" rx="3.2" ry="10" fill={`url(#${cup})`} />
        <ellipse cx="35.4" cy="31" rx="0.9" ry="4" fill="#ffffff" opacity="0.3" />
      </g>
      {/* music note */}
      <g fill="#cfe0ff" opacity="0.85">
        <ellipse cx="16.6" cy="24.4" rx="1.6" ry="1.15" transform="rotate(-20 16.6 24.4)" />
        <rect x="17.8" y="17.6" width="0.9" height="7" rx="0.4" />
        <path d="M18.4 17.6 C20.4 18.4 21.4 19.4 21.3 21.4 C20.6 20 19.6 19.6 18.4 19.6Z" />
      </g>
    </svg>
  );
}
