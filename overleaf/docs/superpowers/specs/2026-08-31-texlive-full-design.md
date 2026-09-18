# Design Specification: Compatible Custom TeX Live Full Docker Image & CI/CD Pipeline

**Date**: 2026-08-31  
**Status**: Draft / Approved for Implementation  
**Topic**: Standalone TeX Live Full Sibling Docker Image & Automated Workflow  

---

## 1. Overview & Objectives

In our sandboxed compiler architecture, the Overleaf control plane (`Dockerfile.slim`) delegates document compilation to sibling Docker containers running TeX Live. 

This specification defines the standalone **`Dockerfile.texlive-full`** image and the corresponding GitHub Actions CI/CD pipeline in **`.github/workflows/build-and-push.yaml`**. The image consolidates the proven compilation layers, CTAN installers, font packages, and policy patches from `Dockerfile-base` and `Dockerfile` while configuring user isolation for CLSI `DockerRunner.js`.

---

## 2. Technical Architecture & Component Details

### 2.1 File Locations

```
overleaf/
└── server-ce/
    ├── Dockerfile.slim              # Lean control plane (~1.5 GB)
    ├── Dockerfile.texlive-full      # [NEW] Standalone TeX Live Full image (~4.2 GB)
    └── config/
        └── latexmkrc                # Global Latexmk configuration ($go_mode = 3;)
.github/
└── workflows/
    └── build-and-push.yaml          # [UPDATED] Automated build & push workflow
```

---

### 2.2 Image Layer Specifications (`Dockerfile.texlive-full`)

#### A. Base Image & System Dependencies
* **Base**: `phusion/baseimage:noble-1.0.3` (Ubuntu 24.04 LTS).
* **System Build Tools & Utilities**:
  - `build-essential`, `wget`, `net-tools`, `unzip`, `time`, `poppler-utils`, `optipng`, `strace`, `git`, `zlib1g-dev`, `libpcre3-dev`, `gettext-base`, `libwww-perl`, `ca-certificates`, `curl`, `gnupg`, `qpdf`, `make`
* **Interpreters & Compilers**:
  - `python3`, `python-is-python3`, `python3-pygments` (required for LaTeX syntax highlighting with `\usepackage{minted}`).
  - `perl` (core runtime for `latexmk` and `biber`).
  - `pandoc` (for document conversions).
* **Graphics & Formats**:
  - `imagemagick`, `ghostscript`, `librsvg2-bin`, `inkscape`.
  - **ImageMagick PDF Policy Fix**:
    ```bash
    sed -i 's/<policy domain="coder" rights="none" pattern="PDF" \/>/<policy domain="coder" rights="read|write" pattern="PDF" \/>/' /etc/ImageMagick-6/policy.xml 2>/dev/null || true
    ```
* **Fonts & Cache**:
  - `fontconfig`, `fonts-liberation`, `fonts-linuxlibertine`, `fonts-freefont-ttf`, `fonts-dejavu-core`, `fonts-noto-cjk`.
  - Font cache updated with `fc-cache -f -v`.

#### B. TeX Live Installation & Security Configuration
* **Upstream CTAN Installer**:
  - Verified with upstream `texlive.asc` GPG key and `sha512sum` verification.
  - Install profile options:
    - `tlpdbopt_autobackup 0`
    - `tlpdbopt_install_docfiles 0`
    - `tlpdbopt_install_srcfiles 0`
    - `selected_scheme scheme-full`
  - Build argument: `ARG TEXLIVE_MIRROR=https://mirrors.mit.edu/CTAN/systems/texlive/tlnet` (fallback to `https://mirror.ctan.org/systems/texlive/tlnet`).
* **Binaries & Path Additions**:
  - `tlmgr path add` linking all binaries into `/usr/local/bin`.
  - Tools included: `pdflatex`, `xelatex`, `lualatex`, `dvilualatex`, `latexmk`, `texcount`, `synctex`, `biber`, `bibtex`, `chktex`, `lacheck`, `xindy`, `makeindex`.
* **TeX Live Configuration**:
  - `shell_escape = t` enabled in `texmf.cnf` for dynamic compilation packages.
  - `COPY server-ce/config/latexmkrc /usr/local/share/latexmk/LatexMk` configuring `$go_mode = 3;`.

#### C. User & Execution Isolation
* **Non-Root User `tex`**:
  - Create user `tex` with UID `1000` (`useradd -u 1000 -m -s /bin/bash tex`).
  - Directories `/compile` and `/tmp` owned by `tex:tex`.
  - Environment: `ENV HOME=/tmp` and `ENV TEXMFVAR=/tmp/texmf-var`.
  - Default `USER tex` and `WORKDIR /compile`.

---

### 2.3 CI/CD Workflow (`.github/workflows/build-and-push.yaml`)

We add build jobs for the new images alongside the existing images:

1. **`build-sharelatex-slim`**:
   - Builds `overleaf/server-ce/Dockerfile.slim`.
   - Tags:
     - `${{ env.REGISTRY1 }}/${{ github.actor }}/sharelatex-slim:latest`
     - `${{ env.REGISTRY1 }}/${{ github.actor }}/sharelatex-slim:${{ steps.build_env.outputs.date }}`
     - `${{ vars.DOCKER_USERNAME }}/sharelatex-slim:latest`
     - `${{ vars.DOCKER_USERNAME }}/sharelatex-slim:${{ steps.build_env.outputs.date }}`
   - Cache: `type=gha,scope=sharelatex-slim`.

2. **`build-texlive-full`**:
   - Builds `overleaf/server-ce/Dockerfile.texlive-full`.
   - Tags:
     - `${{ env.REGISTRY1 }}/${{ github.actor }}/texlive-full:latest`
     - `${{ env.REGISTRY1 }}/${{ github.actor }}/texlive-full:${{ steps.build_env.outputs.date }}`
     - `${{ vars.DOCKER_USERNAME }}/texlive-full:latest`
     - `${{ vars.DOCKER_USERNAME }}/texlive-full:${{ steps.build_env.outputs.date }}`
   - Cache: `type=gha,scope=texlive-full`.

---

## 3. Verification & Acceptance Criteria

1. **Local Dockerfile Validation**:
   - `Dockerfile.texlive-full` parses without syntax errors using Docker BuildKit.
2. **Sandbox Compilation Test**:
   - Spawning a container from `texlive-full` as user `tex` (UID 1000) successfully compiles LaTeX documents (`pdflatex`, `xelatex`, `lualatex`, `latexmk`).
3. **Pygments / Minted Support**:
   - `python3 -m pygments --version` succeeds inside the container.
4. **CI/CD Workflow Validation**:
   - `.github/workflows/build-and-push.yaml` is syntactically valid YAML and includes all jobs with correct cache scopes and tagging conventions.
