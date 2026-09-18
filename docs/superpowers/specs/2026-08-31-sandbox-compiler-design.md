# Design Specification: Overleaf Sandboxed Compiler & Lean Control Plane

**Date**: 2026-08-31  
**Status**: Approved / Ready for Implementation  
**Target Directory**: `overleaf/`  
**Branch**: `worktree-sandbox-compiler`

---

## 1. Overview & Architectural Goal

This design specification details the implementation of the **Sandboxed Compiler** architecture for Overleaf Community Edition. 

In standard Community Edition, LaTeX compiles run directly as a local subprocess inside the monolithic container where the heavy 10GB+ TeX Live distribution is installed. In this sandboxed architecture:
1. **The Main Service (`server-ce/Dockerfile.slim`)** becomes a lean, fast-building (~1.5GB) control plane housing the Web UI, frontend, backend microservices, and CLSI orchestrator.
2. **The LaTeX Compilation Engine (`services/clsi/app/js/DockerRunner.js`)** delegates compiles to isolated sibling containers (e.g. `texlive-full:<year>`) via the host Docker daemon socket (`/var/run/docker.sock`).
3. **Security & Isolation** are enforced via Linux Seccomp profiles (`seccomp/clsi-profile.json`), dropped capabilities (`CapDrop: ['ALL']`), unprivileged user `tex` (UID 1000), and read-only mounts for auxiliary tasks.
4. **Multi-Version TeX Live Support** is enabled across the Web UI using the existing `ALL_TEX_LIVE_DOCKER_IMAGES` environment variable.

---

## 2. Component Architecture & File Layout

```
overleaf/
├── services/
│   └── clsi/
│       ├── app/js/
│       │   ├── CommandRunner.js        # [Existing] Dynamic runner switcher (local vs docker)
│       │   └── DockerRunner.js         # [NEW] Core Sibling Docker Orchestrator (~400 LOC)
│       ├── seccomp/
│       │   └── clsi-profile.json       # [NEW] Linux Syscall Security Profile (~80 LOC)
│       └── config/
│           └── settings.defaults.cjs   # [Existing] Sandboxed compiles configuration
│
└── server-ce/
    ├── Dockerfile                      # [Existing] Full all-in-one template (untouched)
    ├── Dockerfile.slim                 # [NEW] Production Lean Sandboxed Image (~1.5GB)
    └── config/
        └── settings.js                 # [EDIT] Parse existing ALL_TEX_LIVE_DOCKER_IMAGES
```

---

## 3. Detailed Component Specifications

### 3.1 `services/clsi/app/js/DockerRunner.js`

The `DockerRunner` module implements the interface expected by `CommandRunner.js` and verified by `services/clsi/test/unit/js/DockerRunner.test.js`:

#### Public API:
* `run(projectId, command, directory, image, timeout, env, compileGroup, cwd, callback)`
* `kill(containerId, callback)`
* `destroyOldContainers(callback)`
* `canRunSyncTeXInOutputDir()` $\rightarrow$ returns `true`
* `promises`: Promisified wrappers for `run`, `kill`, and `destroyOldContainers`.

#### Key Responsibilities:
1. **Path Mapping**:
   * Translates the internal container path (`/var/lib/overleaf/data/compiles/:projectId`) to the host path from `Settings.clsi.docker.hostDirCompiles` (`SANDBOXED_COMPILES_HOST_DIR_COMPILES`).
   * Mounts host directory to `/compile` inside sibling containers:
     * Standard Compile (`compileGroup: 'standard'`): `/compile:rw`
     * Auxiliary (`wordcount`, `synctex`, `conversions`): `/compile:ro`
   * Replaces `$COMPILE_DIR` in command arguments with `/compile`.
2. **Security & Options Configuration**:
   * `CapDrop: ['ALL']`
   * `SecurityOpt: ['no-new-privileges', 'seccomp=' + seccompJson]`
   * `User: Settings.clsi.docker.user || 'tex'` (UID 1000)
   * `Env: ['HOME=/tmp', 'CLSI=1', ...]`
   * `HostConfig.AutoRemove: true` for `wordcount`, `synctex`, and `conversions`.
3. **Container Name & Lifecycle**:
   * Computes container name as `project-${projectId}-${fingerprint}`.
   * Checks container existence with `container.inspect()`. If 404, creates container.
   * Attaches demuxed `stdout` / `stderr` streams before starting.
   * Manages timeout: if compile runtime exceeds `timeout`, sends `container.kill()` and returns `{ timedout: true }`.
   * On Docker daemon HTTP 500 errors, destroys container and automatically retries once.
4. **Garbage Collection (`destroyOldContainers`)**:
   * Inspects containers starting with `project-`.
   * Destroys stopped containers older than `Settings.clsi.docker.maxContainerAge` unless recently active in `LastProjectAccess.getLastProjectAccessTime(projectId)`.

---

### 3.2 `services/clsi/seccomp/clsi-profile.json`

A standard Docker seccomp JSON filter with default action `SCMP_ACT_ERRNO` granting permissions for standard POSIX syscalls (`execve`, `fork`, `clone`, `read`, `write`, `stat`, `mmap`, etc.) while denying socket creation for raw packet sniffing and administrative kernel capabilities.

---

### 3.3 `server-ce/Dockerfile.slim`

Created using `server-ce/Dockerfile` as the template with the heavy ~10GB TeX Live layers stripped out:

```dockerfile
# syntax=docker/dockerfile:1-labs
ARG OVERLEAF_BASE_TAG=dangdoan2003/sharelatex-base:latest
FROM $OVERLEAF_BASE_TAG

# Essential runtime dependencies for control plane
RUN apt-get update && apt-get upgrade -y && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git fontconfig python3 librsvg2-bin make fonts-liberation fonts-linuxlibertine && \
    fc-cache -f -v && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /overleaf

# Node.js 24 LTS Krypton
ARG NODE_VERSION=v24.20.0
RUN if ! /usr/bin/node -e "if (parseInt(process.versions.node) < 24) process.exit(1)" 2>/dev/null; then \
      NODE_VER="${NODE_VERSION:-v24.20.0}" && \
      NODE_TAG="v${NODE_VER#v}" && \
      NODE_TAR="node-${NODE_TAG}-linux-x64.tar.xz" && \
      curl -fsSL "https://nodejs.org/dist/${NODE_TAG}/${NODE_TAR}" -o "/tmp/${NODE_TAR}" && \
      curl -fsSL "https://nodejs.org/dist/${NODE_TAG}/SHASUMS256.txt" | grep "${NODE_TAR}" | (cd /tmp && sha256sum -c -) && \
      tar -xJf "/tmp/${NODE_TAR}" -C /usr/local --strip-components=1 && \
      rm -f "/tmp/${NODE_TAR}" && \
      ln -sf /usr/local/bin/node /usr/bin/node && \
      ln -sf /usr/local/bin/npm /usr/bin/npm && \
      ln -sf /usr/local/bin/npx /usr/bin/npx; \
    fi

COPY --parents libraries/*/package.json .yarn/patches/ services/*/package.json tools/migrations/ package.json yarn.lock .yarnrc.yml /overleaf/
COPY server-ce/genScript.js server-ce/services.js /overleaf/

ENV PATH="/overleaf/node_modules/.bin:$PATH"
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && (corepack install -g yarn@4.14.1 2>/dev/null || corepack prepare yarn@4.14.1 --activate)
ENV COREPACK_ENABLE_NETWORK=0

RUN --mount=type=cache,target=/root/.cache \
    --mount=type=cache,target=/root/.yarn/berry/cache,id=server-ce-yarn-cache \
    --mount=type=cache,target=/usr/local/share/.cache/yarn,id=server-ce-yarn-fallback-cache \
    --mount=type=tmpfs,target=/tmp node genScript install | bash

COPY --parents libraries/ services/ tools/migrations/ /overleaf/
RUN --mount=type=cache,target=/root/.cache \
    --mount=type=cache,target=/root/.yarn/berry/cache,id=server-ce-yarn-cache \
    --mount=type=cache,target=/usr/local/share/.cache/yarn,id=server-ce-yarn-fallback-cache \
    --mount=type=cache,target=/overleaf/services/web/node_modules/.cache,id=server-ce-webpack-cache \
    --mount=type=tmpfs,target=/tmp \
    node genScript compile | bash

ADD server-ce/runit /etc/service
ADD server-ce/config/env.sh /etc/overleaf/env.sh
ADD server-ce/nginx/nginx.conf.template /etc/nginx/templates/nginx.conf.template
ADD server-ce/nginx/git-bridge.conf.template /etc/nginx/templates/git-bridge.conf.template
ADD server-ce/nginx/overleaf.conf /etc/nginx/sites-enabled/overleaf.conf
ADD server-ce/nginx/clsi-nginx.conf /etc/nginx/sites-enabled/clsi-nginx.conf
ADD server-ce/logrotate/overleaf /etc/logrotate.d/overleaf
RUN chmod 644 /etc/logrotate.d/overleaf

ADD server-ce/cron /overleaf/cron
ADD server-ce/config/crontab-history /etc/cron.d/crontab-history
RUN chmod 600 /etc/cron.d/crontab-history
ADD server-ce/config/crontab-deletion /etc/cron.d/crontab-deletion
RUN chmod 600 /etc/cron.d/crontab-deletion

RUN for d in /etc/sharelatex /var/lib/sharelatex /var/log/sharelatex; do [ -e "$d" ] && rm -rf "$d"; done; \
    mkdir -p /var/log/overleaf /var/lib/overleaf /etc/overleaf

COPY server-ce/init_scripts/ /etc/my_init.d/
COPY server-ce/init_preshutdown_scripts/ /etc/my_init.pre_shutdown.d/
COPY server-ce/config/settings.js /etc/overleaf/settings.js
COPY server-ce/config/production.json /overleaf/services/history-v1/config/production.json
COPY server-ce/config/custom-environment-variables.json /overleaf/services/history-v1/config/custom-environment-variables.json

ADD server-ce/bin/grunt /usr/local/bin/grunt
RUN chmod +x /usr/local/bin/grunt
ADD server-ce/bin/flush-history-queues /overleaf/bin/flush-history-queues
RUN chmod +x /overleaf/bin/flush-history-queues
ADD server-ce/bin/force-history-resyncs /overleaf/bin/force-history-resyncs
RUN chmod +x /overleaf/bin/force-history-resyncs

ENV SITE_MAINTENANCE_FILE="/etc/overleaf/site_status"
RUN touch $SITE_MAINTENANCE_FILE

ENV OVERLEAF_CONFIG=/etc/overleaf/settings.js
ENV WEB_API_USER="overleaf"
ENV ADMIN_PRIVILEGE_AVAILABLE="true"
ENV OVERLEAF_APP_NAME="Overleaf Community Edition"
ENV OPTIMISE_PDF="true"
ENV KILL_PROCESS_TIMEOUT=55
ENV KILL_ALL_PROCESSES_TIMEOUT=55
ENV GRACEFUL_SHUTDOWN_DELAY_SECONDS=1
ENV NODE_ENV="production"
ENV LOG_LEVEL="info"

EXPOSE 80
ENTRYPOINT ["/sbin/my_init"]
```

---

### 3.4 `server-ce/config/settings.js`

Add the parsing of the existing `ALL_TEX_LIVE_DOCKER_IMAGES` environment variable:

```javascript
if (process.env.ALL_TEX_LIVE_DOCKER_IMAGES) {
  const images = process.env.ALL_TEX_LIVE_DOCKER_IMAGES.split(',')
  const names = (process.env.ALL_TEX_LIVE_DOCKER_IMAGE_NAMES || '')
    .split(',')
    .map(n => n.trim())

  settings.allowedImageNames = images.map((imageName, index) => {
    const trimmedImage = imageName.trim()
    return {
      imageName: trimmedImage,
      imageDesc: names[index] || trimmedImage,
    }
  })
}

if (process.env.TEX_LIVE_DOCKER_IMAGE) {
  settings.currentImageName = process.env.TEX_LIVE_DOCKER_IMAGE
}
```

---

## 4. Verification & Testing Protocol

1. **Unit Testing**:
   * Run the full 1,151-line unit test suite in CLSI:
     ```bash
     cd overleaf/services/clsi
     yarn test:unit test/unit/js/DockerRunner.test.js
     ```
   * All test cases must pass (100% green).
2. **Syntax and Lint Check**:
   * Validate ES module exports and settings parsing.
3. **Control Plane Image Validation**:
   * Verify `server-ce/Dockerfile.slim` syntax and structure.
