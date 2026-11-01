import getMeta from "../../../../../frontend/js/utils/meta";
import { parseErrorBody } from "./errors";
import type {
  Credential,
  DetailsRefetchResult,
  ItemDetailResponse,
  ListItemsParams,
  ListItemsResponse,
  SourceRefetchResult,
  StatusFull,
  StatusSummary,
  SyncSettings,
} from "./types";

export const ADMIN_API = "/admin/templates/api";

type Method = "GET" | "POST" | "DELETE";

type RequestOptions = {
  method?: Method;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
};

type QueryValue = string | number | boolean | null | undefined;

export function loginRedirectUrl(pathname: string, search: string): string {
  return `/login?redirect=${encodeURIComponent(pathname + search)}`;
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, signal } = options;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Csrf-Token": getMeta("ol-csrfToken"),
  };
  let requestBody: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(`${ADMIN_API}${path}`, {
    method,
    headers,
    body: requestBody,
    credentials: "same-origin",
    signal,
  });

  if (!response.ok) {
    const errorBody = await readErrorBody(response);
    if (response.status === 401) {
      window.location.href = loginRedirectUrl(
        window.location.pathname,
        window.location.search,
      );
    }
    throw parseErrorBody(response.status, errorBody);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function itemPath(id: string, action?: string): string {
  const base = `/items/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

export function fetchStatus(): Promise<StatusFull> {
  return request<StatusFull>("/status");
}

export function fetchStatusSummary(): Promise<StatusSummary> {
  return request<StatusSummary>("/status/summary");
}

export function getSyncSettings(): Promise<SyncSettings> {
  return request<SyncSettings>("/settings");
}

export function saveSyncSettings(
  settings: Partial<SyncSettings>,
): Promise<SyncSettings> {
  return request<SyncSettings>("/settings", {
    method: "POST",
    body: settings,
  });
}

export function getCredential(): Promise<Credential> {
  return request<Credential>("/credentials/session");
}

export function saveCredential(cookie: string): Promise<Credential> {
  return request<Credential>("/credentials/session", {
    method: "POST",
    body: { cookie },
  });
}

export function clearCredential(): Promise<Credential> {
  return request<Credential>("/credentials/session", { method: "DELETE" });
}

export function listItems(
  params: ListItemsParams = {},
  signal?: AbortSignal,
): Promise<ListItemsResponse> {
  const query = buildQuery({
    q: params.q,
    sync: params.sync,
    page: params.page,
    pageSize: params.pageSize,
  });
  return request<ListItemsResponse>(`/items${query}`, { signal });
}

export function getItem(
  id: string,
  signal?: AbortSignal,
): Promise<ItemDetailResponse> {
  return request<ItemDetailResponse>(itemPath(id), { signal });
}

// Fetches the upstream details of one item and returns its new sync block
export function hydrateItem(id: string): Promise<DetailsRefetchResult> {
  return request<DetailsRefetchResult>(itemPath(id, "hydrate"), {
    method: "POST",
    body: {},
  });
}

// Runs the same acquisition chain as "Open as template", ignoring the
// cached result. Backoff is not bypassed.
export function refetchSource(id: string): Promise<SourceRefetchResult> {
  return request<SourceRefetchResult>(itemPath(id, "source"), {
    method: "POST",
    body: {},
  });
}

export function crawlerSync(
  rescan = false,
): Promise<{ accepted: true; runId: string }> {
  return request("/crawler/sync", {
    method: "POST",
    body: { action: "sync", rescan },
  });
}

export function crawlerStop(): Promise<{ stopping: true }> {
  return request("/crawler/sync/stop", { method: "POST", body: {} });
}
