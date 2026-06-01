export function shouldEnforceReleaseLifetime(
  deal: { payment_locked?: boolean; paymentLocked?: boolean } | null | undefined
): boolean {
  return !(deal?.payment_locked || deal?.paymentLocked);
}
