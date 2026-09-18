# AI Assist for Overleaf CE — Foundation and Error Assistant

**Date:** 2026-09-09
**Status:** Approved design, pending implementation plan
**Sub-project:** 1 of N (see "Roadmap" below)

## Summary

Overleaf Cloud ships an "AI Assist" bundle powered by Writefull. Community
Edition contains the wiring for it — meta flags, React contexts, paywall
components, a `use-ai` capability — but not the engine: `services/web/tsconfig.json`
aliases `@wf/*` to a `modules/writefull/` directory that does not exist in CE.

This project builds an open, self-hostable engine behind those same seams. It
delivers a shared foundation (module scaffolding, an LLM provider abstraction,
per-user provider configuration, consent, and quota) plus the first
user-facing capability: an **error assistant** that explains a LaTeX compile
error and proposes a fix.

The feature is disabled by default. With `AI_ASSIST_ENABLED` unset, the
instance behaves exactly as upstream Overleaf CE: no routes, no database
indexes, no rendered UI.

## Scope

### In scope

- A new web module, `services/web/modules/ai-assist/`.
- A provider abstraction with two adapters covering five user-facing provider
  types: OpenAI, Anthropic, custom OpenAI-compatible endpoints, custom
  Anthropic-compatible endpoints, and Ollama.
- Per-user provider configuration in Account Settings: users add, edit,
  activate, and delete provider entries, each with its own API key.
- An optional instance-wide default provider configured through environment
  variables, used by any user who has not configured one.
- A one-time per-user consent gate before any document content leaves the
  instance.
- Per-user usage quota.
- The error assistant: a "Suggest fix" action on compile log entries that
  streams an explanation and a proposed fix, with a button to apply the fix to
  the document.

### Out of scope (later sub-projects)

Inline language and grammar proofreading; equation, table, and figure
generators; editor autocomplete and rewrite/paraphrase; full-project retrieval
or embeddings. Each is an independent subsystem with its own UI surface and
prompt shape, and each gets its own spec.

### Roadmap

Sub-project 1 (this document) establishes the module, the provider layer, the
credential store, consent, quota, and the streaming transport. Every later
capability reuses all six. The order for the remainder is a later decision;
the generators are the natural second slice because their toolbar seams
already exist in CE.

## Existing seams in CE

The design plugs into scaffolding upstream already ships, which keeps core
file changes near zero.

| Seam | Location | Use |
|---|---|---|
| `pdfLogEntryHeaderActionComponents` module slot | `frontend/js/features/pdf-preview/components/log-entry-header.tsx:25` | Renders the "Suggest fix" button |
| `pdfLogEntryComponents` module slot | `frontend/js/features/pdf-preview/components/pdf-log-entry-content.tsx:8` | Renders the suggestion panel |
| `button[data-action="suggest-fix"]` | `frontend/js/features/pdf-preview/hooks/use-log-events.ts:46` | Existing click target; the editor already dispatches `editor:view-compile-log-entry` with `suggestFix: true` |
| `FeatureUsageRateLimiter` | `app/src/infrastructure/rate-limiters/FeatureUsageRateLimiter.mjs` | Base class for the usage quota |
| `@overleaf/access-token-encryptor` | used by `modules/github-sync/app/src/GitHubCredentialsManager.mjs:1-35` | Encryption pattern for stored API keys |

`AiFeatureUsageRateLimiter.mjs` is deliberately **not** reused: it is coupled to
Writefull, split tests, and subscription add-ons that do not exist in CE. The
module subclasses the base `FeatureUsageRateLimiter` instead.

The unused upstream meta flags (`ol-showAiFeatures`, `ol-hasUnlimitedAi`,
`ol-hasAiFreeTier`) and the `writefullInstance` editor context are left
untouched. They belong to the SaaS paywall model, which does not apply to a
self-hosted instance; this module gates on its own settings instead.

### Core file changes required

The log-entry user interface needs no core edits — it attaches entirely through
existing module slots. These are the only changes outside `modules/ai-assist/`,
and each is additive and inert when the module is disabled:

1. `config/settings.defaults.js:1160` — add `ai-assist` to `moduleImportSequence`.
2. `config/settings.defaults.js:1049-1155` — register component paths in the
   `pdfLogEntryHeaderActionComponents`, `pdfLogEntryComponents`, and
   `integrationLinkingWidgets` slots, all currently empty or github-sync-only.
3. `app/views/layout-base.pug:73-77` — expose `ol-aiAssistEnabled`, copying the
   adjacent `ol-githubSyncEnabled` block.
4. `frontend/js/features/settings/components/linking-section.tsx:50-55` — add
   `aiAssistEnabled` to the `renderSyncSection` disjunction, exactly as
   `githubSyncEnabled` is handled today. Without this the Integrations section
   stays hidden on a CE instance and the provider widget never renders.
5. `server-ce/nginx/overleaf.conf` — a `location` block for the error-assistant
   route with `proxy_buffering off`.

Note that `services/web` does **not** use the Express `compression` middleware,
so no compression exemption is required.

## Architecture

All code lives in one web module. The error assistant needs the session, the
project, and the document contents, all of which `services/web` already holds;
routing that to a separate service would mean re-authenticating and re-fetching
everything across a network hop, and would add a second container to
`server-ce`. LLM calls are pure I/O, so they do not block the Node event loop.

Extraction into a standalone `services/ai/` remains cheap later, because the
provider adapters sit behind a narrow interface from day one. That extraction
should be revisited only if a future sub-project introduces genuinely heavy
background work, such as embeddings or full-project indexing.

### Module layout

```
services/web/modules/ai-assist/
  index.mjs                          WebModule: isEnabled() gate, router, hooks
  app/src/
    ModuleSettings.mjs               env -> Settings.aiAssist
    models/AiAssistModels.mjs        AiUserProviderConfig, AiUserConsent
    AiProviderConfigManager.mjs      CRUD plus encrypt/decrypt of user keys
    AiProviderResolver.mjs           user config, else env default, else null
    EndpointGuard.mjs                base-URL validation (SSRF defence)
    providers/
      OpenAiAdapter.mjs              openai | openai-compatible | ollama
      AnthropicAdapter.mjs           anthropic | anthropic-compatible
    ErrorAssistantPrompt.mjs         log entry plus doc context -> messages
    AiAssistController.mjs           SSE endpoint, consent, quota
    AiAssistRouter.mjs
    AiUsageRateLimiter.mjs           extends FeatureUsageRateLimiter
  frontend/js/features/
    error-assistant/                 suggest-fix-button.tsx, suggest-fix-panel.tsx,
                                     use-fix-stream.ts
    settings/                        ai-providers-section.tsx
  test/
    unit/ frontend/ acceptance/
```

`index.mjs` follows the `modules/github-sync/index.mjs` contract: the module is
always present in `moduleImportSequence` so its frontend slot registrations
resolve at webpack build time, and every runtime behaviour is gated behind a
single `isEnabled()` check. Router registration stays synchronous, and any hook
callback is invoked on every path including the disabled one.

## Provider abstraction

### Contract

```js
/**
 * @typedef {Object} ChatRequest
 * @property {string} system
 * @property {Array<{ role: 'user' | 'assistant', content: string }>} messages
 * @property {number} maxTokens
 * @property {AbortSignal} signal
 */

/**
 * @typedef {{ type: 'text', text: string } | { type: 'done', usage: object }} ChatChunk
 */

// adapter.streamChat(request: ChatRequest) => AsyncIterable<ChatChunk>
```

Adapters own only HTTP transport and wire-format parsing. Prompt construction,
authorization, consent, and quota all live outside them, so adding a third wire
format later touches nothing else.

### Type-to-adapter mapping

| Type | Adapter | Default base URL | API key |
|---|---|---|---|
| `openai` | `OpenAiAdapter` | `https://api.openai.com/v1` | required |
| `openai-compatible` | `OpenAiAdapter` | user-supplied | optional |
| `anthropic` | `AnthropicAdapter` | `https://api.anthropic.com` | required |
| `anthropic-compatible` | `AnthropicAdapter` | user-supplied | optional |
| `ollama` | `OpenAiAdapter` | `http://localhost:11434/v1` | none |

`OpenAiAdapter` POSTs to `{baseUrl}/chat/completions` with `stream: true` and
reads `choices[0].delta.content` from each `data:` frame, terminating on
`data: [DONE]`. Ollama is covered by this adapter because Ollama serves an
OpenAI-compatible `/v1` surface.

`AnthropicAdapter` POSTs to `{baseUrl}/v1/messages` with `stream: true`, sends
the `anthropic-version` header, and reads `content_block_delta` events for text
and `message_delta` for usage.

## Data model

Two collections owned by the module. The core `User` model is not modified,
which keeps the feature removable and honours the project's modularity rule.

**`AiUserProviderConfig`**

| Field | Type | Notes |
|---|---|---|
| `user_id` | ObjectId | indexed |
| `label` | String | user-visible name, e.g. "Work OpenAI" |
| `type` | String | one of the five provider types |
| `baseUrl` | String | resolved default when the user leaves it blank |
| `model` | String | e.g. `gpt-4o-mini`, `claude-sonnet-5`, `llama3.1` |
| `encryptedApiKey` | String | may be absent for keyless endpoints |
| `isActive` | Boolean | at most one active row per user |
| `createdAt`, `lastUsedAt` | Date | |

Indexes: unique on `(user_id, label)`; partial-unique on `(user_id)` filtered to
`isActive: true`, so the "one active provider" rule is enforced by the database
rather than by application logic.

**`AiUserConsent`**

| Field | Type | Notes |
|---|---|---|
| `user_id` | ObjectId | unique |
| `consentedAt` | Date | |
| `providerFingerprint` | String | `type` plus base-URL host at time of consent |

`providerFingerprint` records which destination the user actually agreed to. It
is informational for auditing; consent is not re-prompted when it changes,
because a user who configures a new provider has self-evidently chosen it.

## Configuration

```
AI_ASSIST_ENABLED=false               # default; unset means pure upstream CE
AI_ASSIST_TOKEN_SECRET=               # required when enabled; encrypts user keys
AI_ASSIST_ALLOW_USER_PROVIDERS=true   # admin may forbid per-user keys
AI_ASSIST_DEFAULT_PROVIDER=           # one of the five types, optional
AI_ASSIST_DEFAULT_BASE_URL=
AI_ASSIST_DEFAULT_API_KEY=
AI_ASSIST_DEFAULT_MODEL=
AI_ASSIST_RATE_LIMIT_PER_DAY=100
AI_ASSIST_MAX_OUTPUT_TOKENS=1024
AI_ASSIST_REQUEST_TIMEOUT_MS=60000
AI_ASSIST_ALLOW_PRIVATE_ENDPOINTS=false
```

`ModuleSettings.mjs` maps these onto `Settings.aiAssist` and derives
`Settings.aiAssistEncryptorOptions`, following
`modules/github-sync/app/src/ModuleSettings.mjs`.

Provider resolution order, implemented in `AiProviderResolver`:

1. The user's active `AiUserProviderConfig`, if any and if
   `AI_ASSIST_ALLOW_USER_PROVIDERS` is true.
2. The environment default, if `AI_ASSIST_DEFAULT_PROVIDER` is set.
3. None. The panel renders a "Configure an AI provider" call to action linking
   to Account Settings.

When `AI_ASSIST_ALLOW_USER_PROVIDERS` is false, the settings section renders
read-only text explaining that the administrator has fixed the provider, and
the API rejects writes to the provider-config endpoints.

## Request flow

1. The user clicks "Suggest fix" on a compile log entry. The editor's existing
   `editor:view-compile-log-entry` event with `suggestFix: true` already routes
   to this button (`use-log-events.ts:42-50`).
2. The client issues `POST /project/:projectId/ai/error-assistant` with
   `Accept: text/event-stream` and a body of `{ docId, logEntry, contextRange }`,
   where `logEntry` carries the error's message, raw text, level, and line, and
   `contextRange` is the `{ from, to }` line span the client wants explained.
   The server treats `contextRange` as a hint and clamps it to the configured
   maximum, so a client cannot use it to exfiltrate an entire document in one
   request. It reads the response with `fetch` plus `ReadableStream`, because
   `EventSource` cannot issue a POST.
3. `AiAssistController` checks, in order: module enabled; the user's **read
   access to the project, re-derived server-side** from the session rather than
   trusted from the request; consent recorded; quota available; a provider
   resolvable.
4. `ErrorAssistantPrompt` builds the messages: a system prompt establishing the
   LaTeX-expert role and the required output contract, and a user message
   carrying the error message, the file name, the error line, and roughly forty
   lines of surrounding source.
5. The adapter streams. The controller relays each chunk as an SSE frame of
   `{ type: 'delta' | 'done' | 'error' }`. A client-side `AbortController`
   propagates cancellation and unmount to the upstream provider request.
6. The model responds with an explanation followed by a delimited fix block
   that carries the line range it rewrites.
7. **Apply fix** is offered only when the document's current text at that range
   still matches what was sent. If the user has edited in the meantime, the
   button is disabled and the panel explains that the document changed since
   the last compile, rather than silently clobbering their edits.

### Streaming transport

`services/web` currently contains no SSE endpoint, so this route introduces the
pattern and must handle two things that otherwise buffer the stream into
uselessness:

- Send `X-Accel-Buffering: no` alongside `Content-Type: text/event-stream` and
  `Cache-Control: no-cache`.
- Add a `location` block with `proxy_buffering off` to
  `server-ce/nginx/overleaf.conf`. The catch-all `location /` there proxies to
  web with buffering on by default, which would hold the whole response until
  the model finished — the feature would appear to hang, then complete
  instantly.

`services/web` does not use the Express `compression` middleware, so no
compression exemption is needed.

Periodic SSE comment frames act as a heartbeat so idle intermediaries do not
close a stream while the model is still thinking.

## Security

**Server-side request forgery is the sharpest edge in this design.** A
user-supplied base URL turns an authenticated user into a source of outbound
requests from inside the deployment's network. `EndpointGuard` therefore
validates every base URL before use: the scheme must be `http` or `https`, and
the resolved address must not fall in a private, loopback, or link-local range —
in particular the cloud metadata address `169.254.169.254`. Self-hosters running
Ollama on localhost genuinely need those ranges, so the restriction is lifted by
`AI_ASSIST_ALLOW_PRIVATE_ENDPOINTS=true`, which is off by default and documented
as an explicit trust decision. The guard runs both when a configuration is saved
and again immediately before each request, so a hostname that later resolves
differently cannot slip through.

**Credentials.** API keys are encrypted at rest with
`@overleaf/access-token-encryptor` under `AI_ASSIST_TOKEN_SECRET`, using the
defensive initialisation pattern from `GitHubCredentialsManager.mjs:9-19` so a
missing secret logs an error rather than crashing boot. Keys are never returned
to the browser: the settings UI displays a mask and offers Replace and Delete,
never Reveal.

**Error sanitisation.** Provider responses can echo request headers. Raw
provider error bodies are logged server-side through `logger` and never
forwarded to the client; the client receives a sanitised code and message.

**Consent.** No document content leaves the instance before `AiUserConsent`
exists for that user. The dialog names the provider type and destination host so
the user knows where their source is going — which matters most for users on the
administrator's default provider, since they did not choose it.

## Error handling

| Condition | Behaviour |
|---|---|
| No provider resolvable | Panel shows "Configure an AI provider" with a settings link |
| Provider returns 401/403 | "Your API key was rejected", with a settings link |
| Provider returns 429 | Surfaced as retryable, including the provider's retry hint when present |
| Request timeout or user cancel | Stream closes cleanly; partial text is retained; no Apply offered |
| Quota exhausted | Panel states the limit and when it resets |
| Invalid or blocked base URL | Rejected at save time with a specific message; re-checked before each request |
| Malformed model output | Explanation still renders; Apply is withheld |

## Testing

**Unit.** Adapter SSE-frame parsing for both wire formats against recorded
fixtures, including split frames and mid-stream errors. Prompt construction,
including context-window trimming. Provider resolution precedence across all
three tiers and the `ALLOW_USER_PROVIDERS=false` case. `EndpointGuard` against a
table of SSRF addresses, with and without `ALLOW_PRIVATE_ENDPOINTS`. Credential
encrypt/decrypt round-trip and the missing-secret path.

**Frontend.** The suggestion panel against a mocked stream, covering delta
accumulation, cancel, and error frames. Apply-fix drift detection, both matching
and drifted. Settings section CRUD, including that no key ever reaches the DOM.

**Acceptance.** With `AI_ASSIST_ENABLED` unset: the route returns 404, the
settings section is absent, and no module indexes are created. With it set: the
consent gate, the quota gate, and project authorization each reject
independently, and a user cannot read another user's provider configuration.

**Default-off guarantee.** One acceptance test asserts specifically that a
disabled instance is indistinguishable from upstream CE on every surface this
module touches.

## Open questions

None blocking. Two decisions to revisit after the first slice ships: whether the
generators or editor assistance should be sub-project 2, and whether the
context window sent with an error should grow beyond roughly forty lines once
there is real usage data.
