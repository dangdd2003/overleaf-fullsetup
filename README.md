# Overleaf CE Extend

**Overleaf CE Extend** brings missing enterprise and developer features to self-hosted Overleaf Community Edition (CE)—including an integrated AI writing assistant, track changes and comments, direct Git access, cloud syncing, and sandboxed TeX Live compilation.

It remains 100% backward-compatible with upstream Overleaf CE. Every extension is modular, isolated, and disabled by default; without configuration, the instance runs as standard, untouched Overleaf CE.

### Key Features at a Glance

- **AI Assist**: In-editor LLM assistant (OpenAI, Anthropic, Gemini, Ollama) with ghost-text inline completion, error fix suggestions, multimodal vision, 22 document & PDF tools, web research, checkpoint rewind & forking, and manual, plan, or auto-apply execution modes.
- **Collaboration & Review**: Track changes with accept/reject workflows, inline commenting threads, user @mentions, and a dedicated Reviewer role.
- **Git Bridge & Personal Access Tokens (PAT)**: Clone, pull, and push projects over HTTPS with standard Git CLI/GUI tools using scoped access tokens (`olp_...`).
- **GitHub & Google Drive Sync**: Bi-directional synchronization with GitHub repositories and automated two-way backups with Google Drive.
- **Overleaf MCP Server**: Built-in Model Context Protocol server exposing projects, documents, and compile diagnostics to external AI agents and IDEs.
- **Sandboxed TeX Live Compilation**: Spawns compilation runs in isolated sibling Docker containers with dropped capabilities (`CapDrop: ALL`) and multi-year TeX Live image support.
- **Admin Control Panel**: Web dashboard to manage users, reassign project ownership, revoke active sessions, and review audit logs.
- **Interactive API Docs**: Embedded OpenAPI 3.0 documentation and viewer at `/api-docs`.

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

Renders dynamic JavaScript pages for the AI Assist `web_fetch` tool using two services:
- **`overleaf`**: Main Overleaf application container (formerly `sharelatex`) that makes outbound HTTP rendering requests.
- **`overleaf-browser`**: Sandboxed headless Chrome (Patchright) behind an SSRF-filtering proxy. Disabled by default; only runs when passing `--profile overleaf-browser`.

To start the deployment with the browser service enabled:

1. **Generate an authentication token** (minimum 32 characters):
   ```bash
   openssl rand -hex 32
   ```
2. **Set the token for service `overleaf-browser`** in your root `.env` file or compose environment:
   ```env
   BROWSER_TOKEN=<your_generated_token>
   ```
3. **Configure service `overleaf`** in `variable.env` to connect to the browser service:
   ```env
   AI_ASSIST_BROWSER_URL=http://overleaf-browser:3000
   AI_ASSIST_BROWSER_TOKEN=<your_generated_token>
   ```
4. **Start the containers** with the browser profile:
   ```bash
   docker compose --profile overleaf-browser up -d
   ```

### Enabling Sandboxed Compilers (Optional Sibling Container Sandbox)

The standard image (`dangdoan2003/sharelatex:latest`) compiles LaTeX natively inside the container (`SANDBOXED_COMPILES=false`).

For production multi-tenant environments or the lightweight slim image (`dangdoan2003/sharelatex-slim:latest`), enable **Sandboxed Compilers**. Each compile job runs in an ephemeral sibling Docker container with dropped capabilities (`CapDrop: ALL`), `no-new-privileges`, and custom seccomp profiles.

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
> *`*` = required for the feature. `—` = unset. Keys and URLs take one value or a comma-separated list.*

---

### 1. AI Assist

In-editor LLM agent for LaTeX authoring, compile error diagnostics, contextual writing tools, and web research.

- **In-Editor Assistant**: Context-aware chat sidebar with diff inspection, compiler log parsing, and persistent transcripts.
- **Compiled PDF Tools**: The agent looks at the compiled PDF (page images, layout overview, text search, visual diff between builds, typographic style) and points the user's viewer at a place. Built into AI Assist and enabled with it; no extra environment variables.
- **Checkpoint Rewind & Forking**: Every turn snapshots modified project files. Roll back code, conversation, or both to any previous turn, or fork a chat into an independent branch.
- **Optional Web Tools (`web_search` & `web_fetch`)**: Live web research across 10+ providers (SearXNG, Tavily, Exa, Jina, Firecrawl, etc.) and custom MCP WebSearch endpoints, featuring result caching, key rotation, and cited markdown summaries.
- **Optional Browser Service (`overleaf-browser`)**: Dedicated sandboxed headless Chrome for JavaScript-heavy web pages, protected by egress SSRF filtering and dropped capabilities.

#### Core AI Assist Configuration

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `AI_ASSIST_ENABLED`* | `false` | Turn on AI Assist. |
| `AI_ASSIST_REQUEST_TIMEOUT_SECONDS` | `180` | Seconds to wait for a model's first reply. Raise for slow local models. |
| `DOCKER_HOST_GATEWAY` | auto | Docker host IP, used for `localhost` model URLs. Set for host networking or Podman. |

#### Optional Web Research & Search Providers

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `AI_ASSIST_WEB_TOOLS_ENABLED`* | `false` | Turn on web search and fetch. |
| `AI_ASSIST_SEARXNG_URLS` | — | SearXNG URLs. |
| `AI_ASSIST_TAVILY_API_KEYS` | — | Tavily keys. |
| `AI_ASSIST_EXA_API_KEYS` | — | Exa keys. |
| `AI_ASSIST_JINA_API_KEYS` | — | Jina keys. |
| `AI_ASSIST_FIRECRAWL_API_KEYS` | — | Firecrawl cloud keys. |
| `AI_ASSIST_FIRECRAWL_SELFHOSTED_URLS` | — | Self-hosted Firecrawl URLs. |
| `AI_ASSIST_LANGSEARCH_API_KEYS` | — | LangSearch keys. |
| `AI_ASSIST_OLLAMA_API_KEYS` | — | Ollama web search keys. |
| `AI_ASSIST_WEBSEARCHAPI_API_KEYS` | — | WebSearchAPI keys. |
| `AI_ASSIST_TINYFISH_API_KEYS` | — | TinyFish keys. |
| `AI_ASSIST_PARALLEL_API_KEYS` | — | Parallel keys. |
| `AI_ASSIST_MCP_HEADERS` | — | Extra headers for custom search URLs (JSON or `Key: Value` lines). |
| `AI_ASSIST_MCP_BEARER_TOKEN` | — | Bearer token for custom search URLs. |
| `AI_ASSIST_MCP_URLS` | — | Custom search URLs: take `POST {"q"}`, return `{"results": [...]}`. |
| `AI_ASSIST_WEB_SEARCH_CACHE_HOURS` | `24` | Hours to reuse search results and pages. `0` = no cache. |
| `AI_ASSIST_WEB_SEARCH_MAX_CACHED_SEARCHES` | `256` | Max cached searches. |
| `AI_ASSIST_WEB_SEARCH_MAX_CACHED_PAGES` | `64` | Max cached pages. |

Names are plural (`…_API_KEYS`, `…_URLS`). Any key or URL set turns on server web search for all users; users can also add their own in **Account Settings → AI Features → Web search**.

#### Optional Browser Integration (Service `overleaf` & Service `overleaf-browser`)

The browser capability is divided between two separate services running in independent containers:

- **Service `overleaf`**: The main application server. When an AI agent executes a `web_fetch` tool call on a dynamic JavaScript page, `overleaf` dispatches an authenticated HTTP rendering request to `overleaf-browser`.
- **Service `overleaf-browser`**: A dedicated sandboxed container running headless Google Chrome (Patchright). To protect the host and internal network, all Chrome outbound traffic is forced through an internal guarded proxy (`127.0.0.1:8080`) that strictly blocks requests to internal/private IP ranges (RFC-1918, link-local, loopback, and cloud metadata endpoints).

##### Environment Variables for Service `overleaf` (in `variable.env`)

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `AI_ASSIST_BROWSER_URL`* | — | Browser service URL, e.g. `http://overleaf-browser:3000`. |
| `AI_ASSIST_BROWSER_TOKEN`* | — | Browser service token. Same as `BROWSER_TOKEN`. |

##### Environment Variables for Service `overleaf-browser` (in `docker-compose.yaml` / `.env`)

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `BROWSER_TOKEN`* | — | API token, 32+ characters. |
| `BROWSER_CAPACITY` | `2` | Pages rendered at once. |
| `BROWSER_LANG` | `en-US` | Browser language, e.g. `vi-VN`. |
| `UPSTREAM_PROXY` | — | Outbound proxy: `http://user:pass@host:port` or `socks5://...`. |

#### Agent Modes

The AI agent operates in three execution modes that control how tool calls are handled. The mode is chosen in the chat composer and enforced server-side on every tool invocation. Tool definitions stay identical across modes to preserve provider prompt caching.

| Mode | Behaviour |
| :--- | :--- |
| **Manual** | Every file edit, file creation, and settings change asks the user for approval before executing. Read-only tools (outline, search, compile, etc.) run automatically. |
| **Accept Edits** | File edits, file creations, and project compiler settings apply automatically without asking. Account-level settings (appearance, editor preferences) still require confirmation because they persist across projects. |
| **Plan** | The agent researches and presents a plan for user approval. All file-editing and settings tools are denied; only read-only tools and `present_plan` are available. |

#### Agent Tools

The agent has access to 25 tools (15 project tools, 7 PDF tools, 2 web research tools, and 1 mode tool). Read-only tools execute automatically in all modes; editing and settings tools are gated by the active mode.

**Project tools** (15):

| Tool | Description |
| :--- | :--- |
| `get_outline` | Section tree with file and line ranges, plus the `\input` graph. |
| `get_packages` | Document class and every `\usepackage` with file and line. |
| `get_references` | Every `\label`, `\ref`, and `\cite` with resolution status and duplicate labels. |
| `list_files` | Project files with type and line count (glob filter). |
| `read_file` | Read a text file or line range as numbered lines (first 500 by default). |
| `search_text` | Find a string or regex across project text files with context lines. |
| `edit_file` | Replace text by match or line range, append, or delete in a project file. |
| `create_file` | Create a new project file with initial content. |
| `compile_project` | Compile the project and return errors and warnings. Supports clean rebuild. |
| `get_compile_result` | Errors and warnings of the last compile without rebuilding. |
| `get_project_settings` | Read current compiler, appearance, editor, and spelling settings. |
| `configure_appearance_settings` | Set theme, syntax themes, font, line height, dark-mode PDF (account preferences; always asks). |
| `configure_compiler_settings` | Set engine, TeX Live image, root document, draft mode, stop-on-first-error (project state; auto-applied in Accept Edits). |
| `configure_editor_settings` | Set keybinding mode, auto-complete, bracket pairing, syntax validation, PDF viewer, math preview, breadcrumbs, tabs, spellcheck language (account preferences; always asks). |
| `list_available_settings` | List allowed values for every setting (compilers, TeX Live versions, themes, fonts, sizes, viewers, languages). |

**PDF tools** (7), part of AI Assist and offered whenever it is enabled; read-only, so they run automatically in every mode:

| Tool | Description |
| :--- | :--- |
| `view_compiled_pdf_page` | See one page of the last compiled PDF as an image (150 dpi, or a third of the page zoomed in), or zoom on where a block of source lines is typeset (`path`, `line`, `endLine`: a table, figure, TikZ picture or equation). Returns a SyncTeX map from page height to source line and the page's overfull/underfull boxes; text-only models get the page's text instead of the image. Opens the page of the last edit by default. |
| `view_compiled_pdf_overview` | Up to 12 pages as labelled thumbnails in one image, with paper size, problem fonts (not embedded, Type 3) and per-page measurements: source lines typeset on the page, blank pages, content ending early, large empty bands, ink past the margins, bad boxes and `??`/`[?]` markers. Used to judge the layout across pages and choose a page to open. |
| `search_compiled_pdf` | Find text as the PDF shows it (after macros, numbering, references and citations resolve), ignoring case, line breaks and hyphenation. Returns each match's page, height and the source line that typeset it. |
| `resolve_pdf_block` | Map a block label (`B3`) drawn on a page view with `labels: true` to the source file and lines that typeset it. |
| `diff_compiled_pdf` | Compare the new build with the one before it, page by page: changed regions and one annotated image. The user's PDF viewer highlights the same regions. |
| `inspect_compiled_style` | Text area, margins, columns, fonts and sizes per role, line spacing, rules and colours read from the PDF, each linked to the preamble setting that controls it. |
| `highlight_in_pdf` | Scroll the user's PDF viewer to a source line or region and highlight it. |

**Web tools** (2):

| Tool | Description |
| :--- | :--- |
| `web_search` | Search the web for current information. Returns numbered cited sources with title, URL, date, and snippet. |
| `web_fetch` | Read a web page, PDF, or text file as Markdown. Long documents are paginated; supports `find` for full-document passage search and `page` for section jumps. |

**External MCP connectors**:

Users can configure remote Model Context Protocol (MCP) servers in **Account Settings → AI Features → Connectors**. Connectors are part of AI Assist and need no environment variables of their own.

- **Transports**: Supports Streamable HTTP and HTTP+SSE with automatic discovery.
- **Verified on add**: Saving a connector connects to the server straight away. The dialog closes once it connects; if the server cannot be reached it stays open with the error. Imported connectors are verified the same way.
- **Authentication**: OAuth 2.1 (PKCE, token refresh, dynamic client registration) or custom HTTP headers with sensitive key masking. The server decides: a server that needs no sign-in connects directly, and **Sign in** is only offered after the server asks for it. The sign-in window opens centred on the user's window, only when they click. A server that rejects requests but offers no OAuth sign-in (for example, one that wants an API key) is reported as an error asking for the key as a header.
- **OAuth redirect URL**: `${OVERLEAF_SITE_URL}/ai-assist/connectors/oauth/callback`. There is no separate setting; `OVERLEAF_SITE_URL` must be the public address users open, or the authorization server redirects them to the wrong host.
- **Changing a connector's server**: Moving a connector to another origin clears everything issued for or typed for the old server (tokens, discovered endpoints, client secret, scopes), so none of it is sent to the new host.
- **Card actions**: Connect / Reconnect, Sign in, Configure tools, an enable switch, and a menu with Test connection, Edit, Disconnect and Remove (with confirmation). Successful test and connect results disappear after a few seconds; failures stay until a later attempt succeeds.
- **Config Import**: Import MCP servers directly from Claude Desktop, Cursor, VS Code, or Gemini CLI configs.
- **Permissions**: Per-tool permission controls (Always allow, Needs approval, Blocked). A destructive tool asks every time, even when set to Always allow.
- **Per-chat selection**: In the chat composer, **+ → Connectors** lists the connected servers with a switch for each chat, and **Manage connectors** opens these settings.
- **Tool Integration**: Tools are offered to the model as `mcp__<connector>__<tool>` with the server's own descriptions. Each server's instructions, the available tools, and any connector that needs sign-in or is unreachable are described in the system prompt. When the connector tools would take more than 10% of the model's context window, only their names and summaries are sent and the model loads full definitions with `search_connector_tools`. Long results are paged with `read_connector_result`, and a tool error is reported to the model as an error.
- **Results in chat**: Each call shows the connector, the tool and its arguments, and the output (formatted JSON or Markdown, clipped with Show more, with a copy button).

**Mode tool** (1):

| Tool | Description |
| :--- | :--- |
| `present_plan` | Plan mode only. Present a finished plan for user approval. Call once research is complete. |

#### Slash Commands

Typing `/` in the chat composer opens commands tailored for LaTeX authoring. Each command freezes structured instructions (`<instructions>`), parsed parameters (`<params>`), and pre-gathered project context (`<gathered>`) into that turn without changing the system prompt or tool specs, preserving LLM prompt caching.

| Command | Scope | Gathers | Description |
| :--- | :--- | :--- | :--- |
| `/fix [all] [file.tex:line] [notes]` | Edit | Compile errors, preamble | Fix compile errors, diagnosing root cause before editing. |
| `/layout [page N] [boxes/floats/breaks] [notes]` | Edit | Layout warnings, packages | Fix overfull boxes, misplaced floats, and bad page breaks. |
| `/preamble [add/remove/explain/audit] [package]` | Edit | Preamble, packages | Add, remove, explain, or audit packages without breaking the build. |
| `/rewrite [style] [length] [notes]` | Edit | Section lines | Rewrite prose (clearer, formal, concise, active voice, flow); keeps all LaTeX intact. |
| `/proofread [us/uk] [section/file] [focus]` | Edit | Section lines, packages | Fix spelling, grammar, and punctuation without altering style or math. |
| `/translate <language> [notes]` | Edit | Section lines, packages | Translate text; preserves all macros, math, environments, and cite keys. |
| `/cite [web] [claim]` | Edit | Cursor window, bib keys | Find citation for a claim in project `.bib` files (or web if requested). |
| `/bib [duplicates/fields/casing/unused]` | Edit | Bib keys | Tidy `.bib` entries: remove duplicates, report missing fields, fix title casing. |
| `/table [what it should show]` | Edit | Cursor window, packages, labels | Build or fix a table from values stated in the document. |
| `/figure [image path] [what to draw]` | Edit | Cursor window, packages, labels | Insert a project graphic or draw a clean TikZ diagram. |
| `/equation [inline/display/align] [math in words]` | Edit | Cursor window, macros, packages | Write equations reusing the document's existing math macros and notation. |
| `/explain [what to explain]` | Read | Cursor window, macros | Explain a passage, equation, LaTeX command, package, or error. |
| `/summarize [length] [section or file]` | Read | Document outline | Summarize selection, section, or whole paper strictly from text content. |
| `/review [focus] [section]` | Read | Document outline | Peer-review paper or section: logic, methods, writing clarity, and structure. |
| `/check [refs/cites/notation/terms]` | Read | Labels, bib keys, macros | Audit broken references, uncited keys, and notation/terminology drift. |

#### Inline AI Editor Features

Beyond the chat agent, AI Assist provides editor-integrated features that run their own lightweight provider calls. All inline features are gated by `AI_ASSIST_ENABLED` and the user's AI preference toggle; they require no additional environment variables.

| Feature | Description |
| :--- | :--- |
| **Inline Auto-Completion** | Context-aware LaTeX completion at the cursor (Shift+Space or automatic on typing pause). Adapts to prose, math, tables, figures, and preambles while suppressing suggestions inside comments, command names, and arguments. |
| **Inline Ghost-Text Suggestions** | Streaming ghost-text suggestions accepted with Tab, triggered by Shift+Space, prompt bar, or typing pauses. |
| **Language & Grammar Suggestions** | Grammar and language checks across the open document with diff preview, automatically preserving LaTeX math and macros. |
| **Writing Tools** | Contextual rewrite actions on selected text (Rephrase, Shorten, Make scientific, Split/Join, Translate, Synonyms) with LaTeX validation. |
| **TeXGPT** | Generates titles, abstracts, and keywords directly into document environments using natural language prompts. |
| **Equation Generator** | Converts images of math expressions or text descriptions into LaTeX via vision models, supporting clipboard paste and upload. |
| **Table Generator** | Generates formatted LaTeX tables from natural language prompts or images via the Insert Table menu. |
| **Figure Generator** | Creates complete LaTeX figure environments with optional image uploads (PNG, JPEG, WebP, GIF). |
| **Empty Line Prompt** | Pressing Space on an empty line opens an inline prompt bar for natural-language generation directly at the cursor. |
| **AI Edit Glow** | Editor highlight animation that smoothly scrolls to and highlights newly applied AI changes. |

#### Chat History & Background Runs

| Feature | Description |
| :--- | :--- |
| **Persistent Chat History** | Saves chat transcripts to disk (`/var/lib/overleaf/data/ai-assist`), easily reopened from the history menu. |
| **Auto-Generated Titles** | Automatically names chats based on context instead of timestamp labels. |
| **Background Agent Runs** | Runs continue on the server if you switch chats or close the tab, picking up where they left off when reopened. |
| **Checkpoint Rewind & Forking** | Every turn snapshots modified project files. From the rewind dialog on any message, roll back code and conversation, reset conversation only, rewind code only, or fork the chat into an independent branch with live diff preview. |

#### Suggest Fix & Project Starters

| Feature | Description |
| :--- | :--- |
| **Suggest Fix** | One-click compile error/warning fix in the log panel that autonomously inspects errors and proposes a diff for approval. Uses the project read tools and `edit_file` (no PDF tools); when web tools are enabled it can also look up package documentation and command syntax with `web_search` / `web_fetch`. |
| **Project-Derived Starters** | Instant contextual prompt suggestions in empty chats derived from project structure and compile status. |
| **Selection-Aware Quick Actions** | Selecting text in the editor shows dynamic action chips tailored to the selection type (equations, tables, TikZ, citations) for one-click prompts. |
| **PDF Viewer Context** | Each message carries the visible PDF pages and zoom; text selected in the PDF, a double-click on the PDF, or a box dragged on it is handed to the agent as the matching source lines. |

#### AGENTS.md — Per-Project Instructions

Place an `AGENTS.md` file in the **project root** to give the agent project-specific instructions (style rules, conventions, terminology). Always active when `AI_ASSIST_ENABLED=true` — no extra env var needed.

| Behaviour | Detail |
| :--- | :--- |
| **Matching** | Case-insensitive (`agents.md`, `AGENTS.md`, `Agents.MD`). Root only — subfolders ignored. |
| **Timing** | Read once per run at startup. Mid-run edits take effect on the next run. |
| **Size** | No limit. Blank/whitespace-only file is treated as absent. |
| **Errors** | Failure to read is silently ignored; the run continues without instructions. |
| **Prompt position** | Injected as a second system block after the base prompt. Overrides general style guidance but not tool contract, modes, or the user's request. |

#### BYO Model Provider & Vision

Users configure their own LLM provider and API keys directly in the user settings panel—no provider API keys are stored in server environment variables.

| Feature | Description |
| :--- | :--- |
| **Multi-Provider Support** | Connect OpenAI-compatible endpoints, Anthropic Claude, Google Gemini, or local Ollama instances. Provider URLs include SSRF validation against internal networks. |
| **Dual Model Slots (Main & Fast)** | Independent slots for a main reasoning model (chat assistant, writing tools) and a fast model (inline code completion) to optimize latency and cost. |
| **Reasoning Effort** | Configurable thinking token budget for supported reasoning models (e.g., Claude thinking, OpenAI o-series). |
| **Vision / Multimodal** | Attach images directly to chat messages (PNG, JPEG, WebP, GIF; up to 2 images, 4 MB each) for equation conversion or visual review. |
| **Live Settings Sync** | When the agent modifies appearance, editor, or compiler settings, changes apply in real time with an approval diff. |

---

### 2. Collaboration & Review

Adds inline commenting, comment resolution threads, user @mentions, track changes with per-user suggestions and accept/reject workflows, a dedicated Reviewer role, and batched email digest notifications.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `COLLABORATION_ENABLED`* | `false` | Turn on comments, track changes, Reviewer role, @mentions and email digests. |
| `COMMENT_MENTION_DELAY_MS` | `300000` | Delay before comment emails are sent (ms). |

---

### 3. Google Drive Sync

Bi-directional sync between Overleaf projects and Google Drive via OAuth 2.0, supporting automated folder backups, real-time push webhooks, fallback polling, and AES-encrypted token storage.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `GOOGLE_DRIVE_ENABLED`* | `false` | Turn on Google Drive sync. |
| `GOOGLE_DRIVE_CLIENT_ID`* | — | Google OAuth client ID. |
| `GOOGLE_DRIVE_CLIENT_SECRET`* | — | Google OAuth client secret. |
| `GOOGLE_DRIVE_MAX_RPS` | `8` | Drive API requests per second. Match your Google quota. |
| `GOOGLE_DRIVE_POLL_INTERVAL_SECONDS` | `300` | Seconds between checks for Drive changes, when push is off. |
| `GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS` | `600` | Max seconds before local changes reach Drive. |

Redirect URI to register: `<OVERLEAF_SITE_URL>/oauth/google-drive/callback`. Push updates need HTTPS; otherwise Drive is polled. The token encryption secret is generated automatically.

---

### 4. GitHub Sync

Bi-directional sync between Overleaf projects and GitHub repositories via OAuth 2.0 and Git operations.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `GITHUB_SYNC_ENABLED`* | `false` | Turn on GitHub sync. |
| `GITHUB_CLIENT_ID`* | — | GitHub OAuth app client ID. |
| `GITHUB_CLIENT_SECRET`* | — | GitHub OAuth app client secret. |
| `GITHUB_API_BASE` | `https://api.github.com` | GitHub API URL. Change for GitHub Enterprise. |
| `GITHUB_GIT_BASE` | `https://github.com` | GitHub URL. Change for GitHub Enterprise. |

Callback URL to register: `<OVERLEAF_SITE_URL>/auth/github/callback`. The token encryption secret is generated automatically.

---

### 5. Git Bridge & Personal Access Tokens (PAT)

Enables standard Git operations (clone, commit, push) over HTTPS using scoped Personal Access Tokens (`olp_...`).

Personal Access Tokens turn on with Git Bridge or MCP.

The feature runs across two containers:
- **`overleaf`**: Manages PAT generation, authentication, and Nginx proxying.
- **`git-bridge`**: Java daemon running the Git HTTP server with local bare repos and optional S3 cold storage offload.

#### Environment Variables for Service `overleaf` (in `variable.env`)

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `GIT_BRIDGE_ENABLED`* | `false` | Turn on Git Bridge and access tokens. |
| `GIT_BRIDGE_HOST` | `git-bridge` | Git Bridge service name. |
| `GIT_BRIDGE_PORT` | `8000` | Git Bridge port. |

#### Environment Variables for Service `git-bridge` (in `docker-compose.yaml`)

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `GIT_BRIDGE_API_BASE_URL` | `http://overleaf:3000/api/v0` | Overleaf API URL. Set if the service isn't named `overleaf`. |
| `GIT_BRIDGE_POSTBACK_BASE_URL` | `http://git-bridge:8000` | This container's URL. Set if the service isn't named `git-bridge`. |
| `GIT_BRIDGE_PORT` | `8000` | Listen port. Must match Overleaf's `GIT_BRIDGE_PORT`. |

---

### 6. Overleaf Model Context Protocol (MCP) Server

Exposes an MCP server for Overleaf, allowing external AI agents and IDEs (Claude Desktop, Cursor, etc.) to interact directly with projects, files, and compilation runs via HTTP or stdio.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `MCP_ENABLED`* | `false` | Turn on the MCP server at `<OVERLEAF_SITE_URL>/mcp`. |
| `MCP_TOKEN` | — | Access token for local stdio use (`node app.js --stdio`). |
| `MCP_ALLOWED_HOSTS` | — | Extra hostnames for `/mcp`, e.g. a second domain. |
| `MCP_ALLOWED_ORIGINS` | — | Extra browser origins allowed to call `/mcp`. No `*`. |

---

### 7. Admin User & Project Management

Administrative web tools for managing users and projects:

- **User Directory (`/admin/users`)**: Search users by name, email, or ID; bulk-create accounts via CSV/JSON; and batch-manage active sessions.
- **User Governance (`/admin/users/:userId`)**: Edit profiles, assign site admin privileges, generate password reset links, soft-delete, or purge accounts.
- **Project Ownership Transfer (`/admin/project`)**: Look up projects by ID/URL and reassign ownership to any registered user.
- **Audit Logs**: Track administrative mutations with initiator identities and IP addresses.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `ADMIN_USER_MANAGEMENT_ENABLED`* | `false` | Turn on user admin at `/admin/users`. |
| `ADMIN_PROJECT_MANAGEMENT_ENABLED`* | `false` | Turn on project admin at `/admin/project`. |

---

### 8. TeX Live Compiles & Sandbox

Executes LaTeX compilation jobs in isolated sibling Docker containers with dropped capabilities (`CapDrop: ALL`), `no-new-privileges`, and custom seccomp profiles for secure multi-tenant execution. In production environments, all variables marked with `*` must be configured.

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
| `SANDBOXED_COMPILES`* | `false` | Compile in separate Docker containers. |
| `TEX_LIVE_DOCKER_IMAGE`* | — | Default TeX Live image. Must be in the list below. |
| `ALL_TEX_LIVE_DOCKER_IMAGES`* | — | TeX Live images users can pick. |
| `ALL_TEX_LIVE_DOCKER_IMAGE_NAMES`* | — | Display names for those images, same order. |
| `TEX_LIVE_AUTO_PULL_ENABLED` | `false` | Pull missing TeX Live images automatically. |
| `SANDBOXED_COMPILES_HOST_DIR_COMPILES` | auto | Host path of the compiles dir. Set if detection fails. |
| `SANDBOXED_COMPILES_HOST_DIR_OUTPUT` | auto | Host path of the output dir. Set if detection fails. |

---

### 9. Public API Documentation

Interactive Swagger UI and OpenAPI 3.0 specification viewer at `/api-docs` (and `/api/v0/openapi.json`), dynamically tailored to enabled extensions. Requires an authenticated user session.

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `API_DOCS_ENABLED`* | `false` | Turn on API docs at `/api-docs`. |
