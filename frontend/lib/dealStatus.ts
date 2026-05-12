const COMPLETED_STATUSES = new Set([
  "agreed",
  "settled",
  "completed",
  "released",
  "closed",
  "confidential_completed",
  "settled_pending_session_close",
]);

const CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);
const FAILED_STATUSES = new Set(["failed", "disputed"]);

export function normalizeDealStatus(status?: string | null): string {
  return (status || "").trim().toLowerCase();
}

export function isCompletedDealStatus(status?: string | null): boolean {
  return COMPLETED_STATUSES.has(normalizeDealStatus(status));
}

export function isCancelledDealStatus(status?: string | null): boolean {
  return CANCELLED_STATUSES.has(normalizeDealStatus(status));
}

export function isFailedDealStatus(status?: string | null): boolean {
  return FAILED_STATUSES.has(normalizeDealStatus(status));
}

export function getDealStatusLabel(status?: string | null): string {
  const normalized = normalizeDealStatus(status);
  if (isCompletedDealStatus(normalized)) return "Completed";
  if (isCancelledDealStatus(normalized)) return "Cancelled";
  if (isFailedDealStatus(normalized)) return normalized === "disputed" ? "Disputed" : "Failed";
  if (!normalized) return "Negotiating";
  return normalized.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getDealStatusTextClass(status?: string | null): string {
  if (isCompletedDealStatus(status)) return "text-accent";
  if (isCancelledDealStatus(status) || isFailedDealStatus(status)) return "text-error";
  return "text-warning";
}

export function getDealStatusDotClass(status?: string | null): string {
  if (isCompletedDealStatus(status)) return "bg-accent";
  if (isCancelledDealStatus(status) || isFailedDealStatus(status)) return "bg-error";
  return "bg-warning";
}

export function getDealStageIndex(status?: string | null): number {
  const normalized = normalizeDealStatus(status);
  if (isCancelledDealStatus(normalized) || isFailedDealStatus(normalized)) return -1;
  if (isCompletedDealStatus(normalized)) return 3;

  const map: Record<string, number> = {
    negotiating: 0,
    created: 0,
    payment_locked: 1,
    funded: 1,
    buyer_funded: 1,
    seller_funded: 1,
    release_pending: 2,
  };

  return map[normalized] ?? 0;
}
