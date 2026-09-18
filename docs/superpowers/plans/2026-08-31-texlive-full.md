# Compatible TeX Live Full Docker Image & CI/CD Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone, fully-featured, and compatible TeX Live Full Docker image (`Dockerfile.texlive-full`) and integrate automated build/publish jobs for both `sharelatex-slim` and `texlive-full` into the GitHub Actions CI/CD workflow.

**Architecture:** The TeX Live Full image consolidates all CTAN upstream packages (`scheme-full`), interpreters (Python 3 Pygments, Perl), fonts (Liberation, Linux Libertine, FreeFont, DejaVu, Noto CJK), system tools (Ghostscript, Poppler, Pandoc, ChkTeX, ImageMagick), policy patches, and user isolation (`tex` UID 1000) into a single standalone container image designed specifically for CLSI `DockerRunner.js` sibling execution. GitHub Actions builds and publishes both images to GHCR and Docker Hub with build cache.

**Tech Stack:** Docker (BuildKit), Ubuntu 24.04 (Noble), TeX Live (install-tl), Perl, Python 3 Pygments, GitHub Actions, Dockerode.

## Global Constraints

- Never touch `git push`, `git commit`, `git pull`, or alter remote history (as per user rules in `AGENTS.md`).
- All changes must be scoped strictly to `overleaf/` and `.github/workflows/`.
- The TeX Live image must run cleanly with non-root user `tex` (UID 1000), `CapDrop: ['ALL']`, `no-new-privileges`, and the custom Seccomp profile (`clsi-profile.json`).

---

### Task 1: Create `Dockerfile.texlive-full`

**Files:**
- Create: `overleaf/server-ce/Dockerfile.texlive-full`
- Reference: `overleaf/server-ce/Dockerfile-base`
- Reference: `overleaf/server-ce/Dockerfile`
- Reference: `overleaf/server-ce/config/latexmkrc`

**Interfaces:**
- Consumes: `phusion/baseimage:noble-1.0.3`, `server-ce/config/latexmkrc`
- Produces: `Dockerfile.texlive-full` standalone Dockerfile specification

- [ ] **Step 1: Write `overleaf/server-ce/Dockerfile.texlive-full`**

```dockerfile
# syntax=docker/dockerfile:1-labs
# -----------------------------------------------------------
# Overleaf Sandboxed TeX Live Full Sibling Container
# -----------------------------------------------------------

FROM phusion/baseimage:noble-1.0.3

# Default CTAN mirror (can be overridden via build-arg)
ARG TEXLIVE_MIRROR=https://mirrors.mit.edu/CTAN/systems/texlive/tlnet

ENV DEBIAN_FRONTEND=noninteractive
ENV TEXMFVAR=/tmp/texmf-var
ENV HOME=/tmp

# 1. Install all system dependencies, fonts, interpreters, and utilities
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
      build-essential wget net-tools unzip time poppler-utils optipng strace git \
      python3 python-is-python3 python3-pygments zlib1g-dev libpcre3-dev gettext-base \
      libwww-perl ca-certificates curl gnupg qpdf make \
      fontconfig pandoc imagemagick ghostscript librsvg2-bin inkscape chktex lacheck \
      fonts-liberation fonts-linuxlibertine fonts-freefont-ttf fonts-dejavu-core fonts-noto-cjk && \
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-6/policy.xml 2>/dev/null || true && \
    fc-cache -f -v && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 2. Install Upstream TeX Live (scheme-full) with GPG & SHA512 Verification
RUN mkdir /install-tl-unx && \
    wget --quiet https://tug.org/texlive/files/texlive.asc && \
    gpg --import texlive.asc && \
    rm texlive.asc && \
    wget --quiet ${TEXLIVE_MIRROR}/install-tl-unx.tar.gz && \
    wget --quiet ${TEXLIVE_MIRROR}/install-tl-unx.tar.gz.sha512 && \
    wget --quiet ${TEXLIVE_MIRROR}/install-tl-unx.tar.gz.sha512.asc && \
    gpg --verify install-tl-unx.tar.gz.sha512.asc && \
    sha512sum -c install-tl-unx.tar.gz.sha512 && \
    tar -xz -C /install-tl-unx --strip-components=1 -f install-tl-unx.tar.gz && \
    rm install-tl-unx.tar.gz* && \
    echo "tlpdbopt_autobackup 0" >> /install-tl-unx/texlive.profile && \
    echo "tlpdbopt_install_docfiles 0" >> /install-tl-unx/texlive.profile && \
    echo "tlpdbopt_install_srcfiles 0" >> /install-tl-unx/texlive.profile && \
    echo "selected_scheme scheme-full" >> /install-tl-unx/texlive.profile && \
    /install-tl-unx/install-tl -profile /install-tl-unx/texlive.profile -repository ${TEXLIVE_MIRROR} && \
    $(find /usr/local/texlive -name tlmgr) path add && \
    rm -rf /install-tl-unx && \
    echo "shell_escape = t" >> $(find /usr/local/texlive/ -type d -name "20*")/texmf.cnf

# 3. Copy Custom Latexmkrc ($go_mode = 3;)
COPY server-ce/config/latexmkrc /usr/local/share/latexmk/LatexMk

# 4. Configure non-root 'tex' user and compilation workspace
RUN useradd -u 1000 -m -s /bin/bash tex && \
    mkdir -p /compile /tmp/texmf-var && \
    chown -R tex:tex /compile /tmp

USER tex
WORKDIR /compile
```

- [ ] **Step 2: Verify file existence and syntax**

Run: `cat overleaf/server-ce/Dockerfile.texlive-full`
Expected: Correct structure, non-root user setup, CTAN install profile.

---

### Task 2: Update GitHub Actions CI/CD Workflow

**Files:**
- Modify: `.github/workflows/build-and-push.yaml`

**Interfaces:**
- Consumes: `overleaf/server-ce/Dockerfile.slim`, `overleaf/server-ce/Dockerfile.texlive-full`
- Produces: GitHub Actions workflow jobs `build-sharelatex-slim` and `build-texlive-full`

- [ ] **Step 1: Add image names and build jobs to `.github/workflows/build-and-push.yaml`**

Add `SLIM_IMAGE_NAME: sharelatex-slim` and `TEXLIVE_FULL_IMAGE_NAME: texlive-full` to `env` block, and define `build-sharelatex-slim` and `build-texlive-full` jobs.

```yaml
      - name: Build slim control plane image
        uses: docker/build-push-action@v6
        with:
          context: ./overleaf
          file: ./overleaf/server-ce/Dockerfile.slim
          build-args: |
            BUILDKIT_INLINE_CACHE=1
            OVERLEAF_BASE_TAG=${{ vars.DOCKER_USERNAME }}/${{ env.BASE_IMAGE_NAME }}:latest
            NODE_VERSION=${{ vars.NODE_VERSION || 'v24.20.0' }}
          cache-from: type=gha,scope=sharelatex-slim
          cache-to: type=gha,mode=max,scope=sharelatex-slim
          tags: |
            ${{ env.REGISTRY1 }}/${{ github.actor }}/${{ env.SLIM_IMAGE_NAME }}:latest
            ${{ env.REGISTRY1 }}/${{ github.actor }}/${{ env.SLIM_IMAGE_NAME }}:${{ steps.build_env.outputs.date }}
            ${{ vars.DOCKER_USERNAME }}/${{ env.SLIM_IMAGE_NAME }}:latest
            ${{ vars.DOCKER_USERNAME }}/${{ env.SLIM_IMAGE_NAME }}:${{ steps.build_env.outputs.date }}
          push: true

  build-texlive-full:
    name: Build TeX Live Full Sibling Image
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4.2.2

      - name: Set build env
        id: build_env
        run: |
          echo "date=$(TZ=Asia/Ho_Chi_Minh date +"%Y-%m-%d")" >> "$GITHUB_OUTPUT"
        shell: bash

      - name: Docker Setup Buildx
        uses: docker/setup-buildx-action@v3.8.0

      - name: Docker login registry ${{ env.REGISTRY1 }}
        uses: docker/login-action@v3.3.0
        with:
          registry: ${{ env.REGISTRY1 }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Docker login registry ${{ env.REGISTRY2 }}
        uses: docker/login-action@v3.3.0
        with:
          username: ${{ vars.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_TOKEN }}

      - name: Build and push texlive-full
        uses: docker/build-push-action@v6
        with:
          context: ./overleaf
          file: ./overleaf/server-ce/Dockerfile.texlive-full
          build-args: |
            BUILDKIT_INLINE_CACHE=1
            TEXLIVE_MIRROR=${{ vars.TEXLIVE_MIRROR }}
          cache-from: type=gha,scope=texlive-full
          cache-to: type=gha,mode=max,scope=texlive-full
          tags: |
            ${{ env.REGISTRY1 }}/${{ github.actor }}/${{ env.TEXLIVE_FULL_IMAGE_NAME }}:latest
            ${{ env.REGISTRY1 }}/${{ github.actor }}/${{ env.TEXLIVE_FULL_IMAGE_NAME }}:${{ steps.build_env.outputs.date }}
            ${{ vars.DOCKER_USERNAME }}/${{ env.TEXLIVE_FULL_IMAGE_NAME }}:latest
            ${{ vars.DOCKER_USERNAME }}/${{ env.TEXLIVE_FULL_IMAGE_NAME }}:${{ steps.build_env.outputs.date }}
          push: true
```

- [ ] **Step 2: Validate YAML syntax**

Run: `node -e "const yaml = require('yaml'); const fs = require('fs'); yaml.parse(fs.readFileSync('.github/workflows/build-and-push.yaml', 'utf8')); console.log('YAML valid');"`
Expected: `YAML valid`

---

### Task 3: Full End-to-End Verification

**Files:**
- Test: `overleaf/services/clsi/test/unit/js/DockerRunner.test.js`

- [ ] **Step 1: Run CLSI test suite in container**

Run: `docker run --rm -v /home/dangdd/projects/overleaf-fullsetup/overleaf/services/clsi/app/js/DockerRunner.js:/overleaf/services/clsi/app/js/DockerRunner.js:ro overleaf-dev-clsi:latest yarn run test:unit`
Expected: 24/24 test files passed, 413/413 tests passed (100%).

- [ ] **Step 2: Verify git status and file integrity**

Run: `git status --short`
Expected: Clean status with only new files added and no unintentional edits.
