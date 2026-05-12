function truthyEnv(key: string): boolean {
  return (process.env[key] || "false").toLowerCase() === "true";
}

export function demoRuntimeListenersAllowed(): boolean {
  if ((process.env.NODE_ENV || "").toLowerCase() === "test") {
    return true;
  }
  return truthyEnv("ALLOW_DEMO_RUNTIME_LISTENERS");
}

export function assertDemoRuntimeListenerAllowed(listenerName: string): void {
  if (!demoRuntimeListenersAllowed()) {
    throw new Error(`demo_runtime_listener_disabled:${listenerName}`);
  }
}
