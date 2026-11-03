import { getConfig } from './configStore';
import { getSecret } from './secrets';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const isApiConfigured = () => getConfig().server.apiBaseUrl.trim().length > 0;

/**
 * JSON request to the backend (server.apiBaseUrl). Expected endpoints:
 *   POST   /auth/login          { email, password }            -> { token, user: { email, name? } }
 *   POST   /pairings            { barcode, barcodeType, tagId, tagUid, tagName, gatewayId } -> { id }
 *   DELETE /pairings/:id
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const base = getConfig().server.apiBaseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new ApiError('Backend API is not configured', 0);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false) {
    const token = await getSecret('authToken');
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError(ctrl.signal.aborted ? 'Request timed out' : `Network error: ${(e as Error).message}`, 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return json as T;
}
