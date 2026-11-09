// Draw the Summit Thread logo: teal mountain line, amber sun, and amber thread
// Decorative by default; pass a title when the logo stands alone without visible text
export function SummitLogo({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      className={className}
      viewBox="60 110 1080 860"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <polyline className="logo-mountain" points="120,912 455,298 607,487 747,222 1080,912" fill="none" stroke="#2DD4BF" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round" />
      <path className="logo-thread" d="M122 908 C 230 855, 360 838, 560 868 C 760 900, 900 920, 1080 872" fill="none" stroke="#FBBF24" strokeWidth="34" strokeLinecap="round" />
      <circle className="logo-sun" cx="747" cy="186" r="60" fill="#FBBF24" />
    </svg>
  );
}

// Link home with the logo and wordmark; the accessible name stays "Summit Thread home"
export function BrandMark({ href = '/' }: { href?: string }) {
  return (
    <a className="wordmark brand-mark" href={href} aria-label="Summit Thread home">
      <SummitLogo className="brand-mark-logo" />
      <span>Summit Thread</span>
    </a>
  );
}
