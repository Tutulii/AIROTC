"use client";

import { useSystemToasts } from "@/lib/useSystemToasts";

/**
 * Client component boundary for system-level hooks
 * that need to be mounted inside the ToastProvider.
 */
export function SystemHooks() {
    useSystemToasts();
    return null;
}
