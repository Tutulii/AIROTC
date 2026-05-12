export function redactUrlSecret(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["api-key", "apikey", "token", "access_token", "key"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "***");
      }
    }
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
