"use client";

// Data access with the same source ladder as the feed: the Next.js route handlers
// over Neon come first (that's what exists on Vercel), the FastAPI engine second
// (local dev / Compose), demo data last — handled by the callers.

import { API_URL } from "./format";

async function tryJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Try the local route handler, then the FastAPI backend. */
export async function apiGet<T>(localPath: string, backendPath?: string): Promise<T | null> {
  const local = await tryJson<T>(localPath);
  if (local && (local as { source?: string }).source !== "unconfigured"
      && (local as { source?: string }).source !== "error") {
    return local;
  }
  if (backendPath) {
    const remote = await tryJson<T>(`${API_URL}${backendPath}`);
    if (remote) return remote;
  }
  return local;
}

export async function apiPost<T>(localPath: string, body: unknown, backendPath?: string): Promise<T | null> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const local = await tryJson<T>(localPath, init);
  if (local) return local;
  if (backendPath) return tryJson<T>(`${API_URL}${backendPath}`, init);
  return null;
}
