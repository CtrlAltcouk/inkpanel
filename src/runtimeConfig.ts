export const DEFAULT_HTTPS_PORT = 8443;

/** Public runtime capabilities. HTTPS is advertised only while its listener is active. */
export interface RuntimeState {
  httpsPort: number | null;
}

export function createRuntimeState(): RuntimeState {
  return { httpsPort: null };
}

export interface ResolvedHttpsPort {
  httpsPort: number | null;
  error: string | null;
}

/** Resolve the browser-only HTTPS port once on the server. */
export function resolveHttpsPort(raw: string | undefined): ResolvedHttpsPort {
  if (raw === undefined) return { httpsPort: DEFAULT_HTTPS_PORT, error: null };

  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    return {
      httpsPort: null,
      error: `HTTPS_PORT must be an integer between 1 and 65535 (received ${JSON.stringify(raw)})`,
    };
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return {
      httpsPort: null,
      error: `HTTPS_PORT must be an integer between 1 and 65535 (received ${JSON.stringify(raw)})`,
    };
  }

  return { httpsPort: port, error: null };
}
