// One place for talking to the Express API.

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Options extends Omit<RequestInit, "body"> {
  json?: unknown; // sent as JSON
  body?: BodyInit; // e.g. FormData for recordings
  allow401?: boolean; // don't jump to the login page on 401 (used by the "who am I" check)
}

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const { json, allow401, headers, ...rest } = opts;
  const res = await fetch(path, {
    ...rest,
    credentials: "same-origin", // send the session cookie
    headers: json !== undefined ? { "Content-Type": "application/json", ...(headers || {}) } : headers,
    body: json !== undefined ? JSON.stringify(json) : opts.body,
  });
  if (res.status === 401 && !allow401) {
    window.location.assign("/login");
    throw new ApiError("Please log in again.", 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || "Something went wrong. Try again.", res.status, data.code);
  return data as T;
}

export const today = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

export const fmt = (n: number) => "Rs " + Math.round(Math.abs(n)).toLocaleString("en-US");
