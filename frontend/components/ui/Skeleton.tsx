"use client";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = "" }: SkeletonProps) {
  return <div className={`skeleton ${className}`} />;
}

export function StatCardSkeleton({ isPrimary = false }: { isPrimary?: boolean }) {
  return (
    <div
      className={`bg-bg-card p-${isPrimary ? "6" : "5"} border-l ${
        isPrimary ? "border-accent lg:col-span-2" : "border-border-subtle"
      }`}
    >
      <Skeleton className="h-3 w-24 mb-3" />
      <Skeleton className={`${isPrimary ? "h-14 w-40" : "h-8 w-28"} mb-2`} />
      {isPrimary && <Skeleton className="h-1 w-full mt-6" />}
    </div>
  );
}

export function TableRowSkeleton({ cols = 4 }: { cols?: number }) {
  return (
    <div className={`grid grid-cols-${cols} py-5 border-b border-border-subtle/30`}>
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className="px-6">
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

export function EventSkeleton() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="w-2 h-2 rounded-full mt-1.5" />
      <div className="flex-1">
        <Skeleton className="h-4 w-full mb-2" />
        <Skeleton className="h-3 w-16" />
      </div>
    </div>
  );
}

export function AgentCardSkeleton() {
  return (
    <div className="bg-bg-card p-6 border border-border-subtle">
      <div className="flex items-center gap-4 mb-6">
        <Skeleton className="h-12 w-12 rounded-lg" />
        <div>
          <Skeleton className="h-5 w-28 mb-2" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
      <Skeleton className="h-1 w-full" />
    </div>
  );
}
