import getMeta from "../../../../../frontend/js/utils/meta";
import { ADMIN_API } from "./client";
import { parseErrorBody } from "./errors";

// Storage and duplicate-template admin API (app/src/controllers/StorageController.mjs)

export type DedupAreaCounts = { files: number; bytes: number };

export type DedupReport = {
  dryRun: boolean;
  purge: boolean;
  skipped: string | null;
  startedAt: string;
  finishedAt: string | null;
  duplicates: {
    candidates: number;
    groups: number;
    duplicates: number;
    applied: number;
    planned: number;
    blobRefsUnset: number;
    reasons: Record<string, number>;
  } | null;
  freed: {
    files: number;
    bytes: number;
    byCategory: Record<string, DedupAreaCounts>;
  } | null;
  reclaimable: DedupAreaCounts | null;
  purged: { deleted: number; bytes: number; pending: number; skipped: string | null } | null;
};

export type DedupStatus = {
  report: DedupReport | null;
  lastRunAt: string | null;
  tombstones: number;
  pendingPurge: number;
  running: { id: string; state: string; attempt: number; createdAt: string | null } | null;
  storage: {
    usedBytes: number;
    files: number;
    areas: Record<string, DedupAreaCounts>;
    freeBytes: number | null;
    totalBytes: number | null;
    measuredAt: string | null;
  } | null;
};

export type DuplicateRow = {
  token: string;
  title: string;
  canonical: string;
  duplicateAt: string | null;
  slug: string | null;
  family: string | null;
};

async function request<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
): Promise<T> {
  const { method = "GET", body } = options;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Csrf-Token": getMeta("ol-csrfToken"),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${ADMIN_API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!response.ok) {
    let errorBody: unknown = null;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = null;
    }
    throw parseErrorBody(response.status, errorBody);
  }
  return (await response.json()) as T;
}

export function fetchDedupStatus(): Promise<DedupStatus> {
  return request<DedupStatus>("/storage/dedup");
}

/** dryRun defaults to a preview on the server; purge applies only to a clean run */
export function runDedup(opts: { dryRun: boolean; purge: boolean }) {
  return request<{ queued: true; deduped: boolean; dryRun: boolean; purge: boolean }>(
    "/storage/dedup/runs",
    { method: "POST", body: { dryRun: opts.dryRun, purge: opts.purge } },
  );
}

export function fetchDuplicates(limit = 50): Promise<{ duplicates: DuplicateRow[] }> {
  return request<{ duplicates: DuplicateRow[] }>(
    `/storage/dedup/duplicates?limit=${limit}`,
  );
}

export function restoreDuplicate(token: string) {
  return request<{ restored: true; token: string; canonical: string }>(
    `/storage/dedup/duplicates/${encodeURIComponent(token)}/restore`,
    { method: "POST", body: {} },
  );
}
