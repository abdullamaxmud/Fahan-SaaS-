export interface ApiErrorBody {
  code: string;
  message: string;
  correlationId?: string;
  details?: { path?: string; message: string }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody,
  ) {
    super(body.message);
  }
  get code() {
    return this.body.code;
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)fahan_csrf=([^;]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

/** Calls the API through the same-origin proxy. Every write carries the CSRF token. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = init.method ?? (init.body ? 'POST' : 'GET');
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrfToken() } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({ error: { code: 'NETWORK', message: 'The server did not respond. Check your connection and try again' } }));
  if (!res.ok) throw new ApiError(res.status, json.error);
  return json.data as T;
}
