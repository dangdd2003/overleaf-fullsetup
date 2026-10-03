# overleaf-browser

Optional page reading for Overleaf AI Assist `web_fetch`: Google Chrome driven by Patchright inside a hardened single-container sandbox, behind an authenticated HTTP API (`/v1/raw`, `/v1/render`, `/v1/fetch`).

## Security model

The browser container is treated as **compromised**: any page may run code in it. The container is sandboxed and hardened so that whatever a page does, only parsed and sanitized text/HTML/image data is extracted and returned to Overleaf:

1. **Internal Traffic Blocked by Default:** Outbound network requests from Google Chrome and `fetchSmall` route through an internal guarded proxy (`127.0.0.1:8080`) inside the container. The proxy resolves DNS and blocks all internal/private addresses (RFC-1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, link-local `169.254.0.0/16`, and non-web ports). A page cannot probe Overleaf, MongoDB, Redis, or cloud metadata.
2. **Upstream HTTP and SOCKS5 Proxy Support:** Outbound web traffic can be chained through an external upstream proxy (HTTP, HTTPS, or SOCKS5 with or without credentials) via standard environment variables (`UPSTREAM_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`).
3. **Hardened Docker Isolation:**
   - Chrome's own sandbox is always on and **verified at startup** from `/proc`: every renderer must have its own PID namespace and seccomp filter, or the container exits;
   - Custom seccomp profile, `cap_drop: ALL`, `no-new-privileges:true`, read-only root filesystem, uid 1001;
   - Limits on CPU, memory (no swap), pids, file descriptors, and `/tmp:nosuid,nodev,noexec`;
   - Pages and downloads capped at 128 MB;
   - On every Chrome launch, all site storage is purged except cookies and preferences (stale locks from abrupt stops are cleaned automatically);
   - No `curl`, `npm` or `yarn` in the image.

## Production (Dokploy, same compose app as Overleaf)

**Host requirements**
- Ubuntu 23.10 and later restrict unprivileged user namespaces through AppArmor. If the browser exits with "Chrome's sandbox could not start", set `kernel.apparmor_restrict_unprivileged_userns=0` on the host. Debian hosts do not need this.

**Dokploy settings**
- Add `seccomp.json` from this folder as a File Mount named `seccomp.json`. Compose then finds it at `../files/seccomp.json`.
- Environment: `BROWSER_TOKEN=<random, at least 32 characters>`.

**Compose** (add to the Overleaf compose; pin image tags to a dated build such as `:2026-10-02` rather than `:latest`):

```yaml
services:
  overleaf:
    # ...existing settings...
    environment:
      AI_ASSIST_BROWSER_URL: "http://overleaf-browser:3000"
      AI_ASSIST_BROWSER_TOKEN: "${BROWSER_TOKEN}"

  overleaf-browser:
    profiles: ["overleaf-browser"]
    restart: always
    image: dangdoan2003/overleaf-browser:latest
    container_name: overleaf-browser
    environment:
      BROWSER_TOKEN: "${BROWSER_TOKEN}"
      BROWSER_LANG: "en-US"
      PROXY_PORT: "8080"
      # Optional upstream proxy (HTTP or SOCKS5 with optional credentials):
      # UPSTREAM_PROXY: "http://user:pass@proxy.example.com:8080"
      # UPSTREAM_PROXY: "socks5://user:pass@proxy.example.com:1080"
    volumes:
      - overleaf-browser-profile:/data/profile
    security_opt:
      - "seccomp=../files/seccomp.json"
      - "no-new-privileges:true"
    cap_drop: [ALL]
    read_only: true
    tmpfs:
      - /tmp:size=512m,nosuid,nodev,noexec
    shm_size: 1gb
    mem_limit: 2g
    memswap_limit: 2g
    cpus: 2
    pids_limit: 512
    ulimits:
      nofile: { soft: 4096, hard: 4096 }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3
    logging:
      options: { max-size: "10m", max-file: "3" }

volumes:
  overleaf-browser-profile:
```

## Settings

| Variable | Meaning |
|---|---|
| `BROWSER_TOKEN` | Required, at least 32 characters; the same value as Overleaf's `AI_ASSIST_BROWSER_TOKEN` |
| `PROXY_PORT` | Port for the internal guarded proxy, default `8080` (bound to `127.0.0.1`) |
| `UPSTREAM_PROXY` | Optional upstream HTTP or SOCKS5 proxy: `http://[user:pass@]host:port` or `socks5://[user:pass@]host:port`. Fallbacks: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`. |
| `BROWSER_CAPACITY` | Pages open at once, default 2; keep `AI_ASSIST_BROWSER_CONCURRENCY` at or below it |
| `BROWSER_LANG` | Browser language, default `en-US` |

`/v1/fetch` reads one small file (a site icon, at most 1 MB) by plain HTTP through the internal proxy, without opening a Chrome page; with `"head": true` it reads a page only up to its `</head>`. A file that a bot check refuses to plain HTTP (403, 503 or a challenge page) is read again by Chrome, on 2 pages kept for this. It has places of its own, so icons never wait behind page reads, and it keeps a host's cooldown but not the 2 s spacing between page reads.

There is no way to turn Chrome's sandbox off. The browser image is amd64 only, because Google Chrome has no Linux arm64 build.

## Tests

- `npm test` runs the unit tests.
