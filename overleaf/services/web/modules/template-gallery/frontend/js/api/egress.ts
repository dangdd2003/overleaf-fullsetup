import getMeta from "../../../../../frontend/js/utils/meta";
import { parseErrorBody } from "./errors";

// Admin API for outbound proxies. client.ts does not export its request
// helper, so this file carries the same small wrapper: same base path, CSRF
// header, JSON and error envelope.
const ADMIN_EGRESS_API = "/admin/templates/api/egress";

export type EgressScheme = "http" | "https" | "socks5" | "socks5h";

export type EgressHealth = {
  state: "idle" | "ok" | "error" | "backoff";
  backoffUntil: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastStatus: number | null;
};

export type EgressProxy = {
  id: string;
  label: string;
  scheme: EgressScheme;
  host: string;
  port: number;
  enabled: boolean;
  allowPrivate: boolean;
  hasAuth: boolean;
  health: EgressHealth;
};

export type EgressConfig = {
  proxies: EgressProxy[];
};

// Omit `username` and `password` to keep the stored login. An empty
// `password` clears it.
export type EgressProxyInput = {
  label?: string;
  scheme?: EgressScheme;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  enabled?: boolean;
  allowPrivate?: boolean;
};

export type EgressBulkLineError = {
  line: number;
  // index of the address among all tokens in the pasted text
  position: number;
  input: string;
  error: string;
};

export type EgressBulkResult = {
  added: EgressProxy[];
  errors: EgressBulkLineError[];
  proxies: EgressProxy[];
};

export type EgressProbeResult = {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  proxyAddress: string;
  error?: string;
};

type Method = "GET" | "POST" | "DELETE";

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function egressRequest<T>(
  path: string,
  method: Method = "GET",
  body?: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Csrf-Token": getMeta("ol-csrfToken"),
  };
  let requestBody: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(`${ADMIN_EGRESS_API}${path}`, {
    method,
    headers,
    body: requestBody,
    credentials: "same-origin",
  });

  if (!response.ok) {
    const errorBody = await readErrorBody(response);
    if (response.status === 401) {
      window.location.href = `/login?redirect=${encodeURIComponent(
        window.location.pathname + window.location.search,
      )}`;
    }
    throw parseErrorBody(response.status, errorBody);
  }
  return (await response.json()) as T;
}

export function getEgress(): Promise<EgressConfig> {
  return egressRequest<EgressConfig>("");
}

export function createEgressProxy(
  input: EgressProxyInput,
): Promise<{ proxy: EgressProxy }> {
  return egressRequest<{ proxy: EgressProxy }>(
    "/proxies",
    "POST",
    input as Record<string, unknown>,
  );
}

// One proxy URL per line. Lines that fail are returned in `errors`; the rest
// are saved even when some lines fail.
export function addProxiesBulk(
  text: string,
  allowPrivate: boolean,
): Promise<EgressBulkResult> {
  return egressRequest<EgressBulkResult>("/proxies/bulk", "POST", {
    text,
    allowPrivate,
  });
}

export function updateEgressProxy(
  id: string,
  input: EgressProxyInput,
): Promise<{ proxy: EgressProxy }> {
  return egressRequest<{ proxy: EgressProxy }>(
    `/proxies/${encodeURIComponent(id)}`,
    "POST",
    input as Record<string, unknown>,
  );
}

export function deleteEgressProxy(id: string): Promise<EgressConfig> {
  return egressRequest<EgressConfig>(
    `/proxies/${encodeURIComponent(id)}`,
    "DELETE",
  );
}

export function testEgressProxy(id: string): Promise<EgressProbeResult> {
  return egressRequest<EgressProbeResult>(
    `/proxies/${encodeURIComponent(id)}/test`,
    "POST",
    {},
  );
}
