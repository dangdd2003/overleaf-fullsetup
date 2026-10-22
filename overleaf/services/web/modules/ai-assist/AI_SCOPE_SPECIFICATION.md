# AI Features Architecture & Scope Boundary Specification

This document defines the architectural boundary, security perimeter, authorization model, and execution limits of all Artificial Intelligence features integrated into Overleaf CE (`services/web/modules/ai-assist`, `services/web/modules/mcp`, and `services/mcp`).

---

## 1. Core Isolation & Feature Gating

1. **Default Disabled**: In compliance with Overleaf Community Edition standards, all AI features (`ai-assist`, `mcp`) are strictly disabled by default (`Settings.aiAssist.enabled === false`).
2. **Zero Core Footprint**:
   - Upstream Overleaf core services (`services/web/app`, `clsi`, `document-updater`, `real-time`, `spelling`, `storage`) operate identically whether AI modules are present or absent.
   - When disabled, no AI middleware is registered, no AI database indexes are created, no background workers/reapers are started, and no Redis channels or streams are monitored.
3. **Dedicated Module Spaces**:
   - `services/web/modules/ai-assist`: Frontend UI, agent execution coordinator, context builder, tool runners, connectors client, and web fetch pipelines.
   - `services/web/modules/mcp`: OAuth2 Authorization Server and REST API bridging Overleaf project resources to Model Context Protocol clients.
   - `services/mcp`: Standalone MCP server exposing Overleaf tools (compile, file management, history, LaTeX parsing) over stdio / SSE.

---

## 2. Authorization & Tenant Isolation Model

1. **Strict User & Project Ownership**:
   - Every AI run (`runId`) is immutably bound to the initiating user (`userId`) and the target project (`projectId`).
   - Run management routes (`streamRun`, `stopRun`, `approve`, `queueMessage`, `sendQueuedNow`, `setMode`) enforce ownership: non-owners cannot observe, stream, approve, cancel, or manipulate another user's run, even if they possess read/write access to the project.
2. **Dynamic Permission Validation**:
   - Background runs do not retain permanent authorization. Before every state-mutating tool call (`edit_file`, `create_file`, `configure_compiler_settings`, and connector write tools), user project write permissions (`canUserWriteProjectContent`) are re-evaluated.
   - If user permissions are revoked mid-run, the agent immediately terminates with `accessRevoked`.
   - On account deletion or expiration, `AiAssistUserCleanup` immediately terminates all active user runs and removes associated private chats, checkpoints, and preferences.
3. **Cross-Project Confinement**:
   - AI tools can only read, write, search, or compile files within the single active project root.
   - Path normalization rejects path traversal (`../`, absolute paths, symlinks pointing outside the project tree).
   - The AI has no capability or API to list, discover, or inspect other projects belonging to the user or other users.

---

## 3. Network & SSRF Perimeter

1. **Private Network Blocking**:
   All outbound requests initiated by the AI (web search, web fetch, favicon resolution, connector probes, and OAuth metadata discovery) pass through a hardened SSRF filter blocking:
   - IPv4 Loopback (`127.0.0.0/8`), Private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), Link-Local (`169.254.0.0/16`), Broadcast, and CGNAT (`100.64.0.0/10`).
   - IPv6 Loopback (`::1`), Link-Local (`fe80::/10`), Unique Local (`fc00::/7`), IPv4-mapped (`::ffff:0:0/96`), 6to4 (`2002::/16`), Teredo (`2001:0::/32`), and Site-Local (`fec0::/10`).
   - Cloud metadata endpoints (AWS/GCP/Azure `169.254.169.254`, Azure WireServer `168.63.129.16`).
   - Overleaf internal container endpoints (`redis`, `mongo`, `clsi`, `real-time`, `overleaf-browser`, `git-bridge`).
2. **DNS Rebinding & Pinning**:
   - Hostnames are resolved to IP addresses prior to connection and verified against the blocklist. Connections are pinned to the verified IP.
   - HTTP redirect chains re-validate every target hop against the SSRF filter.
3. **Outbound Protocol Restrictions**:
   - Only `http:` and `https:` schemes are permitted. Internal protocols (`file:`, `gopher:`, `ftp:`, `dict:`, `ws:`) are rejected.

---

## 4. Secrets & Key Governance

1. **Provider Key Containment**:
   - User-provided LLM API keys (OpenAI, Anthropic, Gemini, Groq, Ollama, OpenRouter) are encrypted at rest.
   - Stored provider API keys are strictly bound to their provider type and normalized `baseUrl`. An incoming run request cannot substitute an arbitrary `baseUrl` to exfiltrate an existing stored key.
   - Provider API keys are never returned to the client browser, never emitted in logs, and never included in error messages.
2. **OAuth Token Security**:
   - Connector OAuth tokens and Personal Access Tokens (PATs) use PKCE S256 and strict redirect URI matching.
   - Token requests enforce `redirect: 'manual'` to prevent secret replay to untrusted redirect locations.
   - In MCP client discovery, the Authorization Server `issuer` metadata is strictly checked against the requested issuer before trusting registration or token endpoints.

---

## 5. Tool Execution & Prompt Injection Defenses

1. **Approval Gating**:
   - Destructive operations (`create_file`, `edit_file`, compiler configuration changes, and external connector write actions) require user review and explicit approval.
   - Unannotated MCP tools default to requiring user confirmation.
   - Instructions protection: edits or modifications to project agent instructions (`AGENTS.md`) always prompt for approval, even under automated edit modes (`acceptEdits`).
   - Approval decisions are cryptographically/uniquely bound to the specific `approvalId` to prevent replay or race exploitation.
2. **Exfiltration Mitigation**:
   - Web fetch and search requests containing novel, model-constructed query parameters or oversized search payloads require verification to mitigate automated prompt exfiltration channels.
3. **Untrusted Data Framing**:
   - Content retrieved from project files, web fetches, PDF logs, and external connectors is explicitly demarcated as untrusted input in system prompts, preventing tool outputs from overriding system-level instructions.

---

## 6. Denial of Service & Resource Caps

1. **Concurrency Limits**:
   - Maximum 5 concurrent active AI runs per user across all projects.
   - Maximum 2 concurrent regex search jobs per user.
   - Rate-limited connector probe and registration endpoints.
2. **Memory & Payload Ceilings**:
   - Maximum transcript size bounded by `maxTranscriptBytes` (10MB + 2MB headroom).
   - O(N) bounded transcript hydration in `AiAssistChatHistoryStore` to eliminate quadratic search stalls on adversarial chat histories.
   - Web document downloads and extractions capped at strict size and timeout limits (streaming decompression bombs rejected).

---

## 7. Frontend Security & Presentation

1. **XSS Prevention**:
   - Markdown rendering utilizes DOMPurify with an explicit HTML tag/attribute allowlist.
   - Raw-HTML style injection blocked via attribute pattern validation (`/style\s*=/i`).
   - Links enforce `target="_blank"` with `rel="noopener noreferrer"` and validate protocols to prevent `javascript:` execution.
2. **Storage Isolation**:
   - Sensitive credentials are never persisted in browser `localStorage` or `sessionStorage`.
   - UI views reflect live server authorization state.

