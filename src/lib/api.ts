import { useCallback, useEffect, useRef, useState } from "react";

const USER_KEY = "contextloop.user";
export const getUserId = () => {
  try {
    return localStorage.getItem(USER_KEY) ?? "u_alice";
  } catch {
    return "u_alice";
  }
};
export const setUserId = (id: string) => {
  try {
    localStorage.setItem(USER_KEY, id);
  } catch {}
  window.dispatchEvent(new Event("contextloop:user"));
};

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-user-id": getUserId(), ...((init.headers as any) ?? {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const post = <T = any>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });
export const put = <T = any>(path: string, json: unknown = {}) => api<T>(path, { method: "PUT", json });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });

/** Fetch on mount + whenever `path` or the acting user changes. `null` path = skip. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e: any) {
      if (n === seq.current) setError(e.message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
    const onUser = () => load();
    window.addEventListener("contextloop:user", onUser);
    return () => window.removeEventListener("contextloop:user", onUser);
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

/** Wraps an async action with busy + error state. */
export function useAction<A extends any[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...a);
      } catch (e: any) {
        setError(e.message);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn],
  );
  return { run, busy, error, setError };
}
