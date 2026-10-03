# Overleaf CE Extend

**Overleaf CE Extend** is an enhanced, feature-rich distribution of the open-source Overleaf Community Edition (CE). It brings powerful enterprise capabilities, rich collaboration tools, developer workflows, and modern AI-driven agent integration to self-hosted Overleaf deployments—while maintaining 100% backward compatibility with upstream Overleaf CE.

All extension modules are completely modular, cleanly isolated, and disabled by default. When unconfigured, the system runs as a clean, native upstream Overleaf Community Edition instance.

### Key Features at a Glance

- **AI Assist**: In-editor LLM assistant for LaTeX authoring, real-time compilation error diagnostics, automated code corrections, and persistent chat history. Includes optional live web research (SearXNG, Tavily, Exa, Jina, Firecrawl, Ollama, etc.) and an optional isolated, sandbox-hardened headless browser container (`overleaf-browser`) for dynamic page rendering.
- **Full Collaboration & Review**: Upstream-grade inline commenting, comment resolution threads, user @mentions, track changes with per-user suggestions, accept/reject workflows, the dedicated Reviewer role, and batched email digest notifications.
- **Bi-directional Google Drive Sync**: OAuth 2.0 account linking, automated project backup, real-time Google Drive push webhook integration, and background synchronization reconciliation workers.
- **GitHub Sync**: Bi-directional project synchronization with GitHub repositories via OAuth 2.0 and local Git operations.
- **Git Bridge & Personal Access Tokens (PAT)**: Direct Git repository access over HTTP/HTTPS using standard Git CLI and GUI tools, scoped Personal Access Tokens (`olp_...`), OAuth2 token verification, and optional S3 repository swap offloading.
- **Overleaf Model Context Protocol (MCP) Server**: Native Model Context Protocol interface exposing Overleaf projects, documents, compilation runs, and files to external AI agents and IDEs via HTTP and stdio transports.
- **Admin User & Project Management**: Comprehensive administrative control panel for user search and directory inspection, role management, session revocation, soft delete/restore/purge workflows, secondary email handling, audit logging, and administrative project ownership reassignment.
- **Sandboxed TeX Live Compilation**: Secure compilation execution inside isolated sibling Docker containers with strict seccomp profiles, capability dropping (`CapDrop: ALL`), and automated background/on-demand TeX Live image pulling.
- **Interactive Public API Documentation**: Embedded OpenAPI 3.0.3 documentation viewer and schema download (`/api-docs` and `/api/v0/openapi.json`) dynamically tailored to enabled extensions.

---

## Deployment Guide

### Prerequisites

- **Docker Engine**: Version 20.10.0 or later.
- **Docker Compose**: Compose V2 (`docker compose` CLI plugin).
- **Hardware Requirements**:
  - Minimum: 2 CPU cores, 4 GB RAM.
  - Recommended (with TeX Live compilations & Browser service): 4+ CPU cores, 8+ GB RAM.

### Quick Start

1. **Clone the repository and prepare configuration**:
   ```bash
   git clone <repository-url> overleaf-extend
   cd overleaf-extend
   ```

2. **Configure environment variables**:
   Inspect and edit `variable.env` to customize your instance settings (site URL, email settings, database credentials, and extension toggles):
   ```bash
   cp variable.env.example variable.env # if starting from a template, or edit variable.env directly
   ```

3. **Start the core services**:
   ```bash
   docker compose up -d
   ```

4. **Verify running services**:
   ```bash
   docker compose ps
   ```

### Persistent Data Volumes

Stateful data across all services is mapped cleanly to persistent directories or Docker volumes:

| Host Directory / Volume | Target Container Path | Purpose |
| :--- | :--- | :--- |
| `./data/overleaf` | `/var/lib/overleaf` | Overleaf uploaded assets, project files, SQLite caches, and AI transcripts |
| `./data/overleaf/log` | `/var/log/overleaf` | Service application and access logs |
| `./data/mongo` | `/data/db` | MongoDB replica set database storage |
| `./data/redis` | `/data` | Redis in-memory datastore persistence files |
| `overleaf-browser-profile` | `/data/profile` | Ephemeral user profile storage for the browser container |

### Running the Browser Service (Optional for AI Web Fetch)

The browser feature consists of two distinct Docker services communicating over the internal Docker network:
1. **Service `sharelatex`** (Main Overleaf Server container): Runs the core application and makes outbound HTTP requests to the browser service when the AI Assist `web_fetch` tool needs to render dynamic web pages.
2. **Service `overleaf-browser`** (Browser Renderer container): Runs isolated headless Google Chrome (Patchright) behind an internal SSRF-filtering proxy. This container is disabled by default and only starts when using the `--profile overleaf-browser` flag.

To start the deployment with the browser service enabled:

1. **Generate an authentication token** (minimum 32 characters):
   ```bash
   openssl rand -hex 32
   ```
2. **Set the token for service `overleaf-browser`** in your root `.env` file or compose environment:
   ```env
   BROWSER_TOKEN=<your_generated_token>
   ```
3. **Configure service `sharelatex`** in `variable.env` to connect to the browser service:
   ```env
   AI_ASSIST_BROWSER_URL=http://overleaf-browser:3000
   AI_ASSIST_BROWSER_TOKEN=<your_generated_token>
   AI_ASSIST_BROWSER_CONCURRENCY=2
   ```
4. **Start the containers** with the browser profile:
   ```bash
   docker compose --profile overleaf-browser up -d
   ```

### Enabling Sandboxed Compilers (Optional Sibling Container Sandbox)

By default, the standard all-in-one image (`dangdoan2003/sharelatex:latest`) includes a full TeX Live scheme and executes compilation natively inside the container (`SANDBOXED_COMPILES=false`).

For production environments serving thousands of users or when using the lightweight slim image (`dangdoan2003/sharelatex-slim:latest`), you can enable **Sandboxed Compilers**. In this mode, each compilation job is spawned in an ephemeral sibling Docker container with complete capability dropping (`CapDrop: ALL`), `no-new-privileges`, and restrictive seccomp security profiles.

To enable sandboxed compilation:

1. **Mount the Docker socket** in `docker-compose.yaml`:
   ```yaml
   services:
     overleaf:
       volumes:
         - "/var/run/docker.sock:/var/run/docker.sock"
   ```

2. **Configure production sandboxed compiler variables in `variable.env`**:
   Compile and output directories are automatically recognized from the mounted data volume. Configure the mandatory compiler variables marked with `*`:
   ```env
   # Enable sibling container compilation sandbox
   SANDBOXED_COMPILES=true

   # Production TeX Live full images (required)
   TEX_LIVE_DOCKER_IMAGE='dangdoan2003/texlive-full:2026'
   ALL_TEX_LIVE_DOCKER_IMAGES='dangdoan2003/texlive-full:2026,dangdoan2003/texlive-full:2025,dangdoan2003/texlive-full:2024,dangdoan2003/texlive-full:2023,dangdoan2003/texlive-full:2022'
   ALL_TEX_LIVE_DOCKER_IMAGE_NAMES='2026 (Latest),2025,2024,2023,2022'
   ```

3. **Restart the containers**:
   ```bash
   docker compose up -d
   ```

### Ports and Access

- **Web Application**: Accessible at `http://localhost:80` (or `http://<server-ip>:80`).
- **Default Admin Account Setup**:
  To initialize the primary administrator user, run:
  ```bash
  docker compose exec overleaf bin/console-admin-create-user --email admin@example.com --password YourSecurePassword123! --admin
  ```

---

## New Features Reference

> For base Overleaf Community Edition features, visit the [official Overleaf documentation](https://docs.overleaf.com).
> 
> *`*` indicates mandatory environment variables that must be defined to make the feature work.*

---

### 1. AI Assist

AI Assist integrates an intelligent LLM agent into Overleaf for LaTeX authoring, real-time compiler error diagnostics, contextual code suggestions, and web research.

- **In-Editor Assistant**: Context-aware chat sidebar, automated code edits with user approval/diff inspection, compiler log parsing, and persistent chat transcripts.
- **Optional Web Tools (`web_search` & `web_fetch`)**: Multi-provider live web search aggregation (SearXNG, Tavily, Exa, Jina, Firecrawl, LangSearch, Ollama, WebSearchAPI, and MCP servers) with key rotation, result caching, prefetching, and cited markdown summaries.
- **Optional Browser Service (`overleaf-browser`)**: An isolated, sandbox-hardened headless Chrome service (Patchright) used by `web_fetch` when dynamic JavaScript rendering is needed. Features strict internal SSRF filtering (blocks RFC-1918, link-local, and loopback probes), capability dropping (`CapDrop: ALL`), custom seccomp, and upstream HTTP/SOCKS5 proxy chaining.

#### Core AI Assist Configuration

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `AI_ASSIST_ENABLED`* | `false` | Master toggle to enable or disable the AI Assist module and UI panel. |
| `AI_ASSIST_CHAT_HISTORY_DIR` | `/var/lib/overleaf/data/ai-assist` | Filesystem directory for persistent chat transcripts. |
| `AI_ASSIST_PROMPT_CACHE_TTL` | `5m` | Anthropic prompt cache TTL duration (`5m` or `1h`). |
| `AI_ASSIST_REQUEST_TIMEOUT_SECONDS` | `180` | HTTP timeout in seconds for upstream LLM provider calls. |
| `AI_ASSIST_APPROVAL_TIMEOUT_SECONDS` | `600` | Timeout in seconds waiting for user tool execution approval. |
| `AI_ASSIST_ORPHAN_GRACE_SECONDS` | `300` | Grace period in seconds before removing disconnected agent runs. |
| `AI_ASSIST_HEARTBEAT_STALE_SECONDS` | `1800` | Inactivity period in seconds before marking a run heartbeat stale. |
| `AI_ASSIST_STREAM_KEEPALIVE_SECONDS` | `15` | Interval in seconds for SSE keepalive ping comments on active run streams. |
| `AI_ASSIST_MAX_TRANSCRIPT_BYTES` | `5000000` | Maximum allowed payload size in bytes for chat run transcripts. |

#### Optional Web Research & Search Providers

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `AI_ASSIST_WEB_TOOLS_ENABLED`* | `false` | Enables web search and fetch tools for the AI assistant. |
| `AI_ASSIST_WEB_SEARCH_SERVER_ENABLED` | `false` | Enables server-configured web search providers for users without individual API keys. |
| `AI_ASSIST_WEB_SEARCH_PRIMARY_PROVIDER` | `searxng` | Primary search provider fallback (`searxng`, `tavily`, `exa`, `jina`, `firecrawl`, `ollama`, `langsearch`, `websearchapi`, `mcp`). |
| `AI_ASSIST_WEB_SEARCH_ROTATION_STRATEGY` | `round-robin` | Provider rotation strategy (`round-robin`, `provider-priority`, or `sticky`). |
| `AI_ASSIST_SEARXNG_URL` / `AI_ASSIST_SEARXNG_URLS` | `""` | Comma-separated base URL(s) of SearXNG instances. |
| `AI_ASSIST_SEARXNG_DEFAULT_CATEGORIES` | `""` | Default search categories for SearXNG queries (e.g. `general,science`). |
| `AI_ASSIST_SEARXNG_DEFAULT_LANGUAGE` | `""` | Default language code for SearXNG queries (e.g. `en-US`). |
| `AI_ASSIST_TAVILY_API_KEY` / `_KEYS` | `""` | Comma-separated API key(s) for Tavily search provider. |
| `AI_ASSIST_EXA_API_KEY` / `_KEYS` | `""` | Comma-separated API key(s) for Exa search provider. |
| `AI_ASSIST_JINA_API_KEY` / `_KEYS` | `""` | Comma-separated API key(s) for Jina search provider. |
| `AI_ASSIST_FIRECRAWL_API_KEY` / `_KEYS` | `""` | Comma-separated API key(s) for cloud Firecrawl provider. |
| `AI_ASSIST_FIRECRAWL_SELFHOSTED_URL` / `_URLS` | `""` | Comma-separated URL(s) for self-hosted Firecrawl instances. |
| `AI_ASSIST_LANGSEARCH_API_KEY` / `_KEYS` | `""` | Comma-separated API key(s) for LangSearch provider. |
| `AI_ASSIST_OLLAMA_API_KEY` / `_KEYS` | `""` | Comma-separated API key(s) for Ollama web search. |
| `AI_ASSIST_WEBSEARCHAPI_API_KEY` / `_KEYS` | `""` | Comma-separated API key(s) for WebSearchAPI provider. |
| `AI_ASSIST_MCP_URL` / `AI_ASSIST_MCP_URLS` | `""` | Comma-separated HTTP/SSE endpoint URL(s) for MCP web search servers. |
| `AI_ASSIST_MCP_BEARER_TOKEN` / `_API_KEY` | `""` | Bearer authorization token or API key for MCP server requests. |
| `AI_ASSIST_MCP_HEADERS` | `""` | Custom headers for MCP server requests (JSON or `Key: Value` format). |
| `AI_ASSIST_WEB_SEARCH_CACHE_HOURS` | `24` | Cache expiration in hours for web searches and fetched web pages. |
| `AI_ASSIST_WEB_SEARCH_MAX_CACHED_SEARCHES` | `256` | Maximum number of queries retained in the LRU web search cache. |
| `AI_ASSIST_WEB_SEARCH_MAX_CACHED_PAGES` | `64` | Maximum number of pages retained in the LRU web page cache. |
| `AI_ASSIST_WEB_PREFETCH_RESULTS` | `3` | Number of top search result URLs to prefetch in background (`0` to disable). |
| `AI_ASSIST_WEB_CACHE_PATH` | `/var/lib/overleaf/data/ai-assist/web-cache.sqlite` | SQLite database file path for cached web results (`:memory:` for RAM). |
| `AI_ASSIST_WEB_EXTRACT_WORKERS` | `2` | Number of worker threads for HTML/PDF content extraction. |
| `AI_ASSIST_CURL_IMPERSONATE` | `/usr/local/lib/curl-impersonate/curl-impersonate` | Binary path for curl-impersonate for browser-like HTTP fetching. |

#### Optional Browser Integration (Service `sharelatex` & Service `overleaf-browser`)

The browser capability is divided between two separate services running in independent containers:

- **Service `sharelatex`**: The main application server. When an AI agent executes a `web_fetch` tool call on a dynamic JavaScript page, `sharelatex` dispatches an authenticated HTTP rendering request to `overleaf-browser`.
- **Service `overleaf-browser`**: A dedicated sandboxed container running headless Google Chrome (Patchright). To protect the host and internal network, all Chrome outbound traffic is forced through an internal guarded proxy (`127.0.0.1:8080`) that strictly blocks requests to internal/private IP ranges (RFC-1918, link-local, loopback, and cloud metadata endpoints).

##### Environment Variables for Service `sharelatex` (in `variable.env`)

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `AI_ASSIST_BROWSER_URL`* | — | HTTP URL of the browser service (e.g., `http://overleaf-browser:3000`). |
| `AI_ASSIST_BROWSER_TOKEN`* | — | Secret token used by `sharelatex` to authenticate against service `overleaf-browser`. Must match `BROWSER_TOKEN`. |
| `AI_ASSIST_BROWSER_CONCURRENCY` | `2` | Maximum concurrent page-render requests that service `sharelatex` will send to the browser service. |

##### Environment Variables for Service `overleaf-browser` (in `docker-compose.yaml` / `.env`)

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `BROWSER_TOKEN`* | — | Authentication secret (minimum 32 characters) required to call the browser HTTP API. |
| `PROXY_PORT` | `8080` | Port of the internal SSRF-prevention egress proxy running inside the browser container. |
| `BROWSER_CAPACITY` | `2` | Maximum number of concurrent Chrome browser tabs/pages allowed in the container. |
| `BROWSER_LANG` | `en-US` | Default `Accept-Language` and UI locale passed to the Chrome process. |
| `UPSTREAM_PROXY` | `""` | Optional upstream proxy (`http://user:pass@host:port` or `socks5://...`) to chain all outbound browser traffic through. |

---

### 2. Collaboration & Review

Enables comprehensive collaboration features in Overleaf Community Edition, including inline comments, thread resolutions, user @mentions, track changes with per-user suggestions and accept/reject workflows, the dedicated Reviewer role, and batched email digest notifications.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `COLLABORATION_ENABLED`* | `false` | Master toggle for all collaboration features: comments, track changes, the Reviewer role, @mentions, in-app notifications, and email digests. When disabled, the instance behaves as standard upstream Community Edition. |
| `COMMENT_MENTION_DELAY_MS` | `300000` | Debounce delay in milliseconds before delivering batched comment and @mention email digest notifications (default: 5 minutes, ceiling: 15 minutes). |

---

### 3. Google Drive Sync

Provides bi-directional synchronization between Overleaf projects and Google Drive. Supports per-user OAuth 2.0 account linking, automated project backup to Google Drive folders, real-time change detection via Google Drive push webhooks, background polling reconciliation workers, and bulk folder imports. Sensitive access tokens are encrypted at rest using AES.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `GOOGLE_DRIVE_ENABLED`* | `false` | Enables bi-directional synchronization between Overleaf projects and Google Drive, mounting OAuth routes, background sync workers, and frontend UI components. |
| `GOOGLE_DRIVE_CLIENT_ID`* | — | Google OAuth 2.0 Client ID obtained from the Google Cloud Console for Google Drive API access. |
| `GOOGLE_DRIVE_CLIENT_SECRET`* | — | Google OAuth 2.0 Client Secret paired with the Client ID for token exchange. |
| `GOOGLE_DRIVE_TOKEN_SECRET` | `""` | Secret key used to encrypt and decrypt stored Google OAuth refresh and access tokens at rest in MongoDB (also supports `GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET`). |
| `GOOGLE_DRIVE_REDIRECT_URI` | `<siteUrl>/oauth/google-drive/callback` | Authorized OAuth 2.0 callback URL registered in the Google Cloud Console. Auto-derived from the site URL if omitted. |
| `GOOGLE_DRIVE_WEBHOOK_URL` | `<siteUrl>/google-drive/webhook` | Public HTTPS endpoint URL for Google Drive push notification webhooks. Required to receive real-time remote change notifications. |
| `GOOGLE_DRIVE_MAX_RPS` | `8` | Maximum allowed Google Drive API requests per second to avoid API rate limiting. |
| `GOOGLE_DRIVE_POLL_INTERVAL_SECONDS` | `300` | Fallback polling interval in seconds to check for remote Google Drive changes when push webhooks are inactive or missed. |
| `GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS` | `600` | Maximum flush delay in seconds for batching and pushing local project changes out to Google Drive. |

---

### 4. GitHub Sync

Enables bi-directional project synchronization between Overleaf projects and GitHub repositories via OAuth 2.0 and Git repository cloning/pushing.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `GITHUB_SYNC_ENABLED`* | `false` | Enables or disables GitHub synchronization functionality across the instance. |
| `GITHUB_CLIENT_ID`* | — | OAuth 2.0 Client ID registered on GitHub for authentication and authorization. |
| `GITHUB_CLIENT_SECRET`* | — | OAuth 2.0 Client Secret registered on GitHub for authentication and authorization. |
| `GITHUB_TOKEN_SECRET`* | — | Secret key used to encrypt and decrypt stored GitHub user access tokens at rest. |
| `GITHUB_REDIRECT_URI` | `${OVERLEAF_SITE_URL}/auth/github/callback` | OAuth 2.0 redirect/callback URI registered with GitHub. |
| `GITHUB_API_BASE` | `https://api.github.com` | Base URL for GitHub REST API requests (customizable for GitHub Enterprise). |
| `GITHUB_GIT_BASE` | `https://github.com` | Base URL for GitHub Git web/clone endpoints (customizable for GitHub Enterprise). |
| `GITHUB_SYNC_REPOS_DIR` | `/var/lib/overleaf/data/github-sync/repos` | Local filesystem directory path used to store cached working Git clones during synchronization. |

---

### 5. Git Bridge & Personal Access Tokens (PAT)

Git Bridge enables full bidirectional Git access for Overleaf projects, allowing users to clone, commit, branch, and push LaTeX projects using standard Git CLI and GUI clients. It includes Personal Access Token (PAT) authentication (`olp_` tokens) with scope-based authorization (`git_bridge`, `mcp`), OAuth2 token verification endpoints, and optional S3 repository swap offloading for inactive projects.

The feature operates across two services:
1. **Service `sharelatex`**: The main application server, which handles routing, Personal Access Tokens, and Nginx proxying to the Git Bridge container.
2. **Service `git-bridge`**: The Java-based Git Bridge daemon container running the Git HTTP server.

#### Environment Variables for Service `sharelatex` (in `variable.env`)

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `GIT_BRIDGE_ENABLED`* | `false` | Master toggle to enable Git Bridge routing, Personal Access Tokens, and Nginx proxying. |
| `GIT_BRIDGE_HOST`* | `git-bridge` | Container or host name of the Git Bridge service used by Nginx to proxy Git traffic. |
| `GIT_BRIDGE_PORT`* | `8000` | Port number that the Git Bridge service listens on (proxied by Nginx). |
| `GIT_BRIDGE_INTERNAL_URL`* | — | Internal HTTP URL of the main web service. Must be set to `http://sharelatex:3000` (or `http://overleaf:3000`) so the `git-bridge` container can retrieve project snapshots and attachments. |
| `PERSONAL_ACCESS_TOKEN_WARNING_WINDOW_DAYS` | `2` | Warning window in days before Personal Access Token expiration notifications are triggered. |

#### Environment Variables for Service `git-bridge` (in `docker-compose.yaml`)

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `GIT_BRIDGE_API_BASE_URL`* | — | Base REST API URL of the web service. In Docker, must be explicitly set to `http://sharelatex:3000/api/v0` (or `http://overleaf:3000/api/v0`). |
| `GIT_BRIDGE_OAUTH2_SERVER`* | — | Base URL of the web service for OAuth2 token validation. In Docker, must be set to `http://sharelatex:3000` (or `http://overleaf:3000`). |
| `GIT_BRIDGE_POSTBACK_BASE_URL`* | — | Postback base URL for Git Bridge. In Docker, must be set to `http://git-bridge:8000`. |
| `GIT_BRIDGE_ROOT_DIR` | `/data` | Root directory inside container where Git Bridge stores bare repositories (defaults to `/data`, formerly `/tmp/wlgb`). |
| `GIT_BRIDGE_PORT` | `8000` | Port that the Git Bridge Java application listens on. |
| `GIT_BRIDGE_BIND_IP` | `0.0.0.0` | IP address that Git Bridge binds to inside its container. |
| `GIT_BRIDGE_IDLE_TIMEOUT` | `30000` | Idle timeout in milliseconds before closing idle Git connections. |
| `GIT_BRIDGE_ALLOWED_CORS_ORIGINS` | `https://localhost` | Allowed CORS origins for Git Bridge HTTP requests. |
| `GIT_BRIDGE_SERVICE_NAME` | `Overleaf` | Display service name reported by Git Bridge during authentication and git prompts. |
| `GIT_BRIDGE_USER_PASSWORD_ENABLED` | `false` | Enables username/password basic auth fallback in addition to OAuth2 / Personal Access Tokens. |
| `GIT_BRIDGE_REPOSTORE_MAX_FILE_NUM` | `2000` | Maximum number of files allowed in a single repository store. |
| `GIT_BRIDGE_REPOSTORE_MAX_FILE_SIZE` | `52428800` | Maximum individual file size in bytes allowed in the repo store (default: 50MB). |
| `GIT_BRIDGE_SWAPSTORE_TYPE` | `noop` | Swap store backend type for project offloading (e.g. `noop`, `s3`). |
| `GIT_BRIDGE_SWAPSTORE_AWS_ACCESS_KEY` | `""` | AWS Access Key ID for S3 swap store backend. |
| `GIT_BRIDGE_SWAPSTORE_AWS_SECRET` | `""` | AWS Secret Access Key for S3 swap store backend. |
| `GIT_BRIDGE_SWAPSTORE_S3_BUCKET_NAME` | `""` | S3 bucket name for swapping inactive Git Bridge repositories. |
| `GIT_BRIDGE_SWAPSTORE_AWS_REGION` | `us-east-1` | AWS Region for S3 swap store backend. |
| `GIT_BRIDGE_SWAPSTORE_AWS_ENDPOINT` | `""` | Custom S3 endpoint URL for S3-compatible object storage (e.g. MinIO, Ceph). |
| `GIT_BRIDGE_SWAPJOB_MIN_PROJECTS` | `50` | Minimum number of projects before swap job activates. |
| `GIT_BRIDGE_SWAPJOB_LOW_GIB` | `128` | Low disk space threshold in GiB to trigger repo swap out. |
| `GIT_BRIDGE_SWAPJOB_HIGH_GIB` | `256` | High disk space threshold in GiB for repo swapping. |
| `GIT_BRIDGE_SWAPJOB_INTERVAL_MILLIS` | `3600000` | Swap job interval in milliseconds (default: 1 hour). |
| `GIT_BRIDGE_SWAPJOB_COMPRESSION_METHOD` | `gzip` | Compression algorithm for swapped repositories (e.g. `gzip`). |
| `GIT_BRIDGE_SQLITE_HEAP_LIMIT_BYTES` | `0` | SQLite memory/heap limit in bytes (`0` for unlimited). |
| `GIT_BRIDGE_JVM_ARGS` | `-XX:+UseContainerSupport -XX:MaxRAMPercentage=50.0 -XX:+ExitOnOutOfMemoryError` | JVM flags and options passed to the Java runtime executing Git Bridge. |

---

### 6. Overleaf Model Context Protocol (MCP) Server

Exposes a Model Context Protocol (MCP) server for Overleaf, allowing external AI agents, LLM applications, and developer tools to interact directly with projects, documents, compilation runs, and file trees via HTTP or stdio transports.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `MCP_ENABLED`* | `false` | Enables or disables the Overleaf MCP server service. |
| `MCP_TRANSPORT` | `http` | Transport protocol used by the MCP server (`http` or `stdio`). |
| `MCP_HOST` | `127.0.0.1` | Host address for the MCP server to bind to. |
| `MCP_PORT` | `3050` | Port number on which the MCP HTTP server listens. |
| `MCP_ENDPOINT_PATH` | `/mcp` | HTTP endpoint path for MCP requests. |
| `MCP_INTERNAL_URL` | `http://127.0.0.1:4000` | Internal URL of the Overleaf web service used by MCP for API calls. |
| `MCP_MAX_UPLOAD_MB` | `20` | Maximum file upload size in megabytes for MCP file operations. |
| `MCP_TOKEN` | `""` | Authentication token required when running MCP with stdio transport. |
| `MCP_ALLOWED_HOSTS` | `""` | Comma-separated list of allowed hostnames when binding `MCP_HOST` beyond loopback. |
| `MCP_ALLOWED_ORIGINS` | `""` | Comma-separated list of allowed origins for CORS and DNS-rebinding protection. |
| `MCP_RESOURCE_URI` | `(derived)` | Explicit resource URI for the MCP server; defaults to `OVERLEAF_SITE_URL` or `host:port` with endpoint path. |

---

### 7. Admin User & Project Management

Provides administrative tooling for managing users, projects, and secondary emails in Overleaf Community Edition:

- **User Directory & Search (`/admin/users`)**: Paginated, sortable, and searchable active user directory matching on names, primary/secondary emails, and MongoDB ObjectIds. Includes deleted user inspection, CSV/JSON bulk user provisioning with one-time password setup tokens, and batch actions (delete, session revocation, restore, purge).
- **User Governance & Detail (`/admin/users/:userId`)**: Detailed metadata view, site admin privilege toggles with safety guards against self-demotion, 7-day password reset link generation, soft-deletion, and instant Redis session termination.
- **Restoration & Purge**: Soft-deleted accounts and projects are archived with support for complete restoration or permanent purging.
- **Audit Logs (`/admin/users/api/users/:userId/audit-logs`)**: Paginated audit trails capturing administrative mutations with initiator identities and IP addresses.
- **Secondary Emails**: Administrative and authenticated self-service secondary email management.
- **Project Governance & Ownership Transfer (`/admin/project`)**: Project URL/ID lookup and instant administrative ownership transfer to any registered user.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `ADMIN_USER_MANAGEMENT_ENABLED`* | `false` | Enables the Admin User Management module (`/admin/users`), providing user directory listing, search, profile editing, admin role management, bulk creation, batch operations, session revocation, soft delete/restore/purge workflows, secondary email handling, and audit logging. |
| `ADMIN_PROJECT_MANAGEMENT_ENABLED`* | `false` | Enables the Admin Project Management module (`/admin/project`), providing project URL/ID lookup, project metadata inspection, and administrative project ownership transfer. |

---

### 8. TeX Live Compiles & Sandbox

Executes LaTeX compilation jobs in isolated sibling Docker containers via the Docker socket. Security containment enforces capability dropping (`CapDrop: ALL`), `no-new-privileges`, and restrictive seccomp BPF security profiles. In production environments serving high concurrent loads, all variables marked with `*` must be configured.

#### Available Pre-built TeX Live Full Sandbox Images

| TeX Live Version | Docker Image Tag | Display Name | Status |
| :--- | :--- | :--- | :--- |
| **2026** | `dangdoan2003/texlive-full:2026` | `2026 (Latest)` | Active / Default |
| **2025** | `dangdoan2003/texlive-full:2025` | `2025` | Supported |
| **2024** | `dangdoan2003/texlive-full:2024` | `2024` | Supported |
| **2023** | `dangdoan2003/texlive-full:2023` | `2023` | Supported |
| **2022** | `dangdoan2003/texlive-full:2022` | `2022` | Supported |

#### Configuration Variables

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `SANDBOXED_COMPILES`* | `false` | Enables sandboxed LaTeX compilation in isolated sibling Docker containers. |
| `TEX_LIVE_DOCKER_IMAGE`* | — | Default TeX Live container image used for LaTeX compilations (e.g. `dangdoan2003/texlive-full:2026`). Must be in `ALL_TEX_LIVE_DOCKER_IMAGES`. |
| `ALL_TEX_LIVE_DOCKER_IMAGES`* | — | Comma-separated list of TeX Live container images available for project selection and automated pulling (e.g. `dangdoan2003/texlive-full:2026,...`). |
| `ALL_TEX_LIVE_DOCKER_IMAGE_NAMES`* | — | Comma-separated display names corresponding to `ALL_TEX_LIVE_DOCKER_IMAGES` for the editor UI dropdown (e.g. `2026 (Latest),2025,...`). |
| `SANDBOXED_COMPILES_HOST_DIR_COMPILES` | `(auto-derived)` | Optional host directory override mapped to `/compile` inside compilation containers. Automatically recognized from the data mount when omitted. |
| `SANDBOXED_COMPILES_HOST_DIR_OUTPUT` | `(auto-derived)` | Optional host directory override mapped to `/output` inside compilation containers. Automatically recognized from the data mount when omitted. |
| `TEX_LIVE_AUTO_PULL_ENABLED` | `false` | Enables automated background pulling of configured TeX Live Docker images at startup and on-demand pull if missing during compile. |
| `DOCKER_RUNNER` | `false` | Alternative alias flag for `SANDBOXED_COMPILES` to activate DockerRunner in CLSI. |
| `ALLOWED_IMAGES` | `""` | Space- or comma-separated list of allowed Docker TeX Live images permitted for compilation in CLSI. |
| `OPTIMISE_PDF` | `true` | Enables PDF optimization (`png2pdf` conversion and caching) inside Docker containers during compilation. |
| `SANDBOXED_COMPILES_HOST_DIR_CACHE` | `""` | Host directory path for CLSI cache, used by `png2pdf` containers to convert images in place. |
| `SECCOMP_PROFILE` | `""` | Custom JSON string for container seccomp security profile (defaults to `services/clsi/seccomp/clsi-profile.json`). |
| `APPARMOR_PROFILE` | `""` | AppArmor security profile name to apply to compilation containers. |
| `DOCKER_RUNTIME` | `""` | Custom OCI container runtime for compilation containers (e.g., `runsc` / gVisor, `kata`). |
| `TEXLIVE_IMAGE_USER` | `tex` | User/UID to execute compilation processes under inside the TeX Live container. |
| `COMPILE_GROUP_DOCKER_CONFIGS` | `{}` | JSON map of compile groups (e.g. `synctex`, `wordcount`, `png2pdf`) to Docker HostConfig overrides. |

---

### 9. Public API Documentation

Interactive public API documentation and OpenAPI 3.0.3 specification viewer for Overleaf CE Extend. It dynamically renders endpoints based on enabled features (including Git Bridge REST API, Personal Access Tokens, MCP REST API, and OAuth2 authorization endpoints) at `/api-docs` with OpenAPI schema download at `/api/v0/openapi.json`. Requires an authenticated user session.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `API_DOCS_ENABLED`* | `false` | Enables the interactive API documentation UI at `/api-docs` and OpenAPI JSON schema endpoint at `/api/v0/openapi.json`. |
