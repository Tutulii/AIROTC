export function redactUrlSecret(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["api-key", "apikey", "token", "access_token", "key"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "***");
      }
    }
    redactProviderPathSecrets(url);
    if (url.password) {
      url.password = "***";
    }
    return url.toString();
  } catch {
    return value
      .replace(/(api-key=)[^&\s]+/gi, "$1***")
      .replace(/(apikey=)[^&\s]+/gi, "$1***")
      .replace(/(access_token=)[^&\s]+/gi, "$1***")
      .replace(/(token=)[^&\s]+/gi, "$1***");
  }
}

function redactProviderPathSecrets(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  const segments = url.pathname.split("/");

  if (hostname.endsWith(".alchemy.com") || hostname === "alchemy.com") {
    redactPathSegmentAfter(segments, "v2");
    url.pathname = segments.join("/");
    return;
  }

  if (hostname.endsWith(".quiknode.pro") || hostname.endsWith(".quiknode.com")) {
    for (let index = 1; index < segments.length; index += 1) {
      if (looksLikeSecretPathSegment(segments[index])) {
        segments[index] = "***";
      }
    }
    url.pathname = segments.join("/");
  }
}

function redactPathSegmentAfter(segments: string[], marker: string): void {
  const markerIndex = segments.findIndex((segment) => segment.toLowerCase() === marker);
  if (markerIndex >= 0 && segments[markerIndex + 1]) {
    segments[markerIndex + 1] = "***";
  }
}

function looksLikeSecretPathSegment(segment: string | undefined): boolean {
  return typeof segment === "string" && /^[A-Za-z0-9_-]{16,}$/.test(segment);
}
