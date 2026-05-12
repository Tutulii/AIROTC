"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import { fetchHealth } from "@/lib/api";

/**
 * useSystemToasts — Fires toast notifications on real system events:
 * 1. Backend connection restored after a failed poll
 * 2. Backend lost after a successful poll
 *
 * Mount this ONCE in a layout-level client component.
 */
export function useSystemToasts() {
    const toast = useToast();
    const wasConnected = useRef<boolean | null>(null);
    const pollCount = useRef(0);

    useEffect(() => {
        const poll = async () => {
            try {
                await fetchHealth();
                const isFirstPoll = wasConnected.current === null;
                const wasOffline = wasConnected.current === false;

                if (!isFirstPoll && wasOffline) {
                    toast.success("Backend connection restored.", {
                        title: "Reconnected",
                    });
                }
                wasConnected.current = true;
            } catch {
                if (wasConnected.current === true) {
                    toast.error("Lost connection to backend API.", {
                        title: "Backend Offline",
                        duration: 8000,
                    });
                }
                wasConnected.current = false;
            }
            pollCount.current++;
        };

        poll();
        const interval = setInterval(poll, 30000);
        return () => clearInterval(interval);
    }, [toast]);
}
