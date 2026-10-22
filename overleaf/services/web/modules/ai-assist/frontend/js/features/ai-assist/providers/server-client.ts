import {
  ChatChunk,
  ChatRequest,
  ProviderClient,
  ProviderError,
  ProviderErrorCode,
  ProviderModel,
  ProviderSettings,
  RetryPolicy,
  WebSearchProviderType,
  WebSearchSettings,
} from "./types";
import { csrfHeaders } from "../utils/csrf";

type WireChunk = ChatChunk | { type: "error"; error?: ErrorBody };

type ErrorBody = { code?: string; message?: string; hint?: string };

function toError(body: ErrorBody | undefined, status?: number): ProviderError {
  return new ProviderError(
    (body?.code as ProviderErrorCode) || "providerError",
    body?.message || "The provider request failed.",
    status,
    body?.hint ? { hint: body.hint } : undefined,
  );
}

async function post(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === "AbortError") {
      throw new ProviderError("aborted", "The request was cancelled.");
    }
    throw new ProviderError("network", "Could not reach the Overleaf server.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw toError(
      payload?.error ?? { message: `Request failed (${response.status})` },
      response.status,
    );
  }
  return response;
}

export type KeyHealthStatus = "works" | "alive" | "dead";

export interface KeyHealthCheck {
  index: number;
  label?: string;
  target: string;
  status: KeyHealthStatus;
  message: string;
  latencyMs?: number;
  resultCount?: number;
}

export interface ProviderHealthReport {
  provider: WebSearchProviderType;
  searchable: boolean;
  latencyMs: number;
  keys: KeyHealthCheck[];
  error?: string;
}

export interface WebSearchTestOutcome {
  latencyMs: number;
  anySuccess: boolean;
  providers?: ProviderHealthReport[];
  activeEndpoints?: number;
  provider?: string;
  resultCount?: number;
}

/** Runs parallel health checks across configured search providers. */
export async function testWebSearch(
  webSearchSettings: WebSearchSettings,
): Promise<WebSearchTestOutcome> {
  const response = await post("/ai-assist/web-search/test", {
    webSearchSettings,
  });
  return await response.json();
}

/**
 * A browser hands back a WHATWG ReadableStream; node-fetch, which the frontend
 * test runner installs as global fetch, hands back an async-iterable stream or
 * an already-buffered body.
 */
async function* bodyChunks(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array,
): AsyncGenerator<Uint8Array> {
  // Checked first: iterating a Uint8Array yields single byte numbers.
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  const readable = body as ReadableStream<Uint8Array>;
  if (typeof readable.getReader !== "function") {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Talks to the provider through the Overleaf server. The page never contacts
 * the provider itself: a site served from a public domain cannot reach
 * providers on a private network, and the server can.
 */
export class ServerProviderClient implements ProviderClient {
  private settings: ProviderSettings;
  private retryPolicy?: RetryPolicy;

  /**
   * `retryPolicy` is how the server retries a failed request before it fails.
   * Its `retrying` chunks reach the caller, which shows them.
   */
  constructor(
    settings: ProviderSettings,
    options: { retryPolicy?: RetryPolicy } = {},
  ) {
    this.settings = settings;
    this.retryPolicy = options.retryPolicy;
  }

  async listModels({ signal }: { signal?: AbortSignal } = {}): Promise<
    ProviderModel[]
  > {
    const response = await post(
      "/ai-assist/providers/models",
      { providerSettings: this.settings },
      signal,
    );
    const payload = await response.json();
    return Array.isArray(payload?.models) ? payload.models : [];
  }

  async test(): Promise<{ latencyMs: number }> {
    const response = await post("/ai-assist/providers/test", {
      providerSettings: this.settings,
    });
    return await response.json();
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const { signal, ...rest } = request;
    yield* this.streamNdjson(
      "/ai-assist/providers/chat",
      {
        providerSettings: this.settings,
        request: rest,
        ...(this.retryPolicy ? { retryPolicy: this.retryPolicy } : {}),
      },
      signal,
    );
  }

  /** Reads the relay's NDJSON reply; an error line throws, a missing `done` is a cut connection. */
  async *streamNdjson(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatChunk> {
    const response = await post(path, body, signal);
    if (!response.body) {
      throw new ProviderError("providerError", "The server sent no response.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    const parse = function* (line: string): Generator<ChatChunk> {
      if (!line.trim()) return;
      let chunk: WireChunk;
      try {
        chunk = JSON.parse(line) as WireChunk;
      } catch {
        throw new ProviderError(
          "network",
          "The provider stream ended unexpectedly.",
        );
      }
      if (chunk.type === "error") throw toError(chunk.error);
      if (chunk.type === "done") finished = true;
      yield chunk;
    };

    const chunks = bodyChunks(response.body);
    try {
      while (true) {
        let result: IteratorResult<Uint8Array>;
        try {
          result = await chunks.next();
        } catch {
          if (signal?.aborted) {
            throw new ProviderError("aborted", "The request was cancelled.");
          }
          throw new ProviderError(
            "network",
            "The connection to the Overleaf server was interrupted.",
          );
        }
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let start = 0;
        let newline = buffer.indexOf("\n", start);
        while (newline !== -1) {
          yield* parse(buffer.slice(start, newline));
          start = newline + 1;
          newline = buffer.indexOf("\n", start);
        }
        buffer = buffer.slice(start);
      }
      yield* parse(buffer + decoder.decode());
    } finally {
      // Releases the connection when the caller stops reading early.
      await chunks.return(undefined);
    }

    if (!finished) {
      if (signal?.aborted) {
        throw new ProviderError("aborted", "The request was cancelled.");
      }
      throw new ProviderError(
        "network",
        "The provider stream ended unexpectedly.",
      );
    }
  }
}

/**
 * A model call from the AI inside the editor: text in, text out, never tools.
 * `retryPolicy` is how the server retries it; the relay defaults to background.
 */
export type EditorTextRequest = Omit<ChatRequest, "tools"> & {
  retryPolicy?: RetryPolicy;
};

/**
 * The only client the AI inside the editor (completion, language
 * suggestions, writing tools, TeXGPT, the table and equation generators)
 * talks to the model with. Its requests carry no tools and go to the
 * relay's text-only route, which refuses tools and drops any tool call or
 * thinking from the reply: these features see the editor's text and
 * nothing else. The chat panel and Error Assist use `ServerProviderClient`.
 */
export class EditorTextClient {
  private relay: ServerProviderClient;

  constructor(
    private readonly settings: ProviderSettings,
    private readonly fallbackSettings?: ProviderSettings | null,
  ) {
    this.relay = new ServerProviderClient(settings);
  }

  async *streamChat(request: EditorTextRequest): AsyncGenerator<ChatChunk> {
    // Whatever the caller's object holds, no tools leave this client
    const {
      signal,
      tools: _tools,
      retryPolicy,
      ...text
    } = request as ChatRequest & EditorTextRequest;
    yield* this.relay.streamNdjson(
      "/ai-assist/providers/editor",
      {
        providerSettings: this.settings,
        ...(this.fallbackSettings
          ? { fallbackProviderSettings: this.fallbackSettings }
          : {}),
        request: text,
        ...(retryPolicy ? { retryPolicy } : {}),
      },
      signal,
    );
  }
}
