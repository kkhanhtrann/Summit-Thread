// Describe visible loading text and compact live-region behavior
interface LoadingIndicatorProps {
  label: string;
  compact?: boolean;
}

// Show an animated progress indicator and announce standalone loading states
export function LoadingIndicator({ label, compact = false }: LoadingIndicatorProps) {
  return (
    <span className={compact ? 'loading-indicator loading-indicator-compact' : 'loading-indicator'} role={compact ? undefined : 'status'}>
      <span className="loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
