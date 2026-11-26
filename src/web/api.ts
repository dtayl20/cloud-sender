// Allow pointing the SPA (running in Vite dev) at the
// deployed Worker. Set VITE_API_BASE to your Worker origin.
const API_BASE = (import.meta as any).env?.VITE_API_BASE?.replace(/\/$/, "") || "";

/** Absolute URL for a Worker path — used for links the browser follows itself (downloads). */
export function apiUrl(path: string): string {
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const url = apiUrl(path);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new Error(
      API_BASE
        ? `Could not reach the API at ${url}. The Worker domain is likely protected by Cloudflare Access, and the Vite preview cannot reuse that login session. Open the app directly at ${API_BASE}, or add an Access policy/service-token setup that allows this preview origin.`
        : `Could not reach the API. The dev preview does not run the Worker backend; open the deployed Worker URL directly or set VITE_API_BASE to it.`,
    );
  }
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json") || text.trimStart().startsWith("<!doctype html") || text.trimStart().startsWith("<html")) {
    const snippet = text.slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `API returned non-JSON (HTTP ${res.status}, ${contentType || "unknown"}) from ${url}. Body: ${snippet || "(empty)"}`
    );
  }

  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {
    throw new Error("API returned invalid JSON.");
  }
  if (!res.ok) throw new Error((data && data.error) ? JSON.stringify(data.error) : `HTTP ${res.status}`);
  return data as T;
}
