"use client";

interface EmptyStateProps {
  icon: string;
  title: string;
  message: string;
}

export function EmptyState({ icon, title, message }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="material-symbols-outlined text-5xl text-text-disabled mb-4">
        {icon}
      </span>
      <h3 className="font-headline font-semibold text-text-secondary text-lg mb-2">
        {title}
      </h3>
      <p className="text-text-muted text-sm max-w-sm">{message}</p>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="material-symbols-outlined text-5xl text-error/50 mb-4">
        error_outline
      </span>
      <h3 className="font-headline font-semibold text-error text-lg mb-2">
        Connection Error
      </h3>
      <p className="text-text-muted text-sm max-w-sm mb-4">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-bg-card border border-border-subtle text-accent text-xs font-bold uppercase tracking-wider hover:bg-bg-highest transition-all"
        >
          Retry
        </button>
      )}
    </div>
  );
}
