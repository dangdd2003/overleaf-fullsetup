# Overleaf Sandboxed Compiler & Lean Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Sandboxed Compiler backend engine (`DockerRunner.js`), Linux Seccomp security profile, settings wiring for multi-version TeX Live images, and the lean `server-ce/Dockerfile.slim` production image for Overleaf Community Edition.

**Architecture:** CLSI routes LaTeX compilation, SyncTeX, and word count operations through `DockerRunner.js` to isolated sibling containers on the host Docker daemon via `/var/run/docker.sock`. Sibling containers are hardened with dropped capabilities (`CapDrop: ALL`), Seccomp filtering, and unprivileged user `tex` (UID 1000). The main `server-ce/Dockerfile.slim` provides a lightweight (~1.5GB) control plane.

**Tech Stack:** Node.js 24 LTS, Dockerode, Vitest / Mocha, Linux Seccomp, Docker API.

## Global Constraints
- Target workspace directory is `overleaf/`.
- Never modify root deployment files (`docker-compose.yml`).
- Maintain 100% test compatibility with the 1,151-line unit test suite (`overleaf/services/clsi/test/unit/js/DockerRunner.test.js`).
- Never perform destructive git commands (`git push`, `commit`, `pull`).

---

### Task 1: Create Linux Seccomp Profile (`clsi-profile.json`)

**Files:**
- Create: `overleaf/services/clsi/seccomp/clsi-profile.json`

**Interfaces:**
- Consumes: Loaded by `overleaf/services/clsi/config/settings.defaults.cjs` line 183 (`JSON.parse(fs.readFileSync(...))`).
- Produces: JSON security profile passed to Docker `SecurityOpt: ['seccomp=' + jsonString]`.

- [ ] **Step 1: Create the Seccomp profile directory and file**

Write the standard Docker Seccomp profile granting permissions for process execution, standard I/O, memory management, and file operations while blocking raw network socket manipulation and administrative capabilities:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": [
    "SCMP_ARCH_X86_64",
    "SCMP_ARCH_X86",
    "SCMP_ARCH_X32",
    "SCMP_ARCH_AARCH64",
    "SCMP_ARCH_ARM"
  ],
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "access", "alarm", "arch_prctl", "bind", "brk",
        "capget", "capset", "chdir", "chmod", "chown", "clock_getres", "clock_gettime",
        "clock_nanosleep", "clone", "clone3", "close", "close_range", "connect",
        "copy_file_range", "dup", "dup2", "dup3", "epoll_create", "epoll_create1",
        "epoll_ctl", "epoll_pwait", "epoll_pwait2", "epoll_wait", "eventfd",
        "eventfd2", "execve", "execveat", "exit", "exit_group", "faccessat",
        "faccessat2", "fadvise64", "fallocate", "fchdir", "fchmod", "fchmodat",
        "fchown", "fchownat", "fcntl", "fdatasync", "flock", "fork", "fstat",
        "fstatfs", "fsync", "ftruncate", "futex", "futex_time64", "futex_waitv",
        "getcwd", "getdents", "getdents64", "getegid", "geteuid", "getgid",
        "getgroups", "getpeername", "getpgid", "getpgrp", "getpid", "getppid",
        "getpriority", "getrandom", "getresgid", "getresuid", "getrlimit",
        "getrusage", "getsid", "getsockname", "getsockopt", "gettid", "gettimeofday",
        "getuid", "ioctl", "kill", "lchown", "link", "linkat", "listen", "lseek",
        "lstat", "madvise", "memfd_create", "mincore", "mkdir", "mkdirat", "mknod",
        "mknodat", "mmap", "mprotect", "mremap", "msync", "munmap", "nanosleep",
        "newfstatat", "open", "openat", "openat2", "pause", "pipe", "pipe2",
        "poll", "ppoll", "ppoll_time64", "prctl", "pread64", "preadv", "preadv2",
        "prlimit64", "pselect6", "pselect6_time64", "pwrite64", "pwritev",
        "pwritev2", "read", "readahead", "readlink", "readlinkat", "readv",
        "recvfrom", "recvmmsg", "recvmsg", "rename", "renameat", "renameat2",
        "restart_syscall", "rmdir", "rseq", "rt_sigaction", "rt_sigpending",
        "rt_sigprocmask", "rt_sigqueueinfo", "rt_sigreturn", "rt_sigsuspend",
        "rt_sigtimedwait", "rt_sigtimedwait_time64", "rt_tgsigqueueinfo",
        "sched_get_priority_max", "sched_get_priority_min", "sched_getaffinity",
        "sched_getparam", "sched_getscheduler", "sched_yield", "select",
        "sendfile", "sendmmsg", "sendmsg", "sendto", "set_robust_list",
        "set_tid_address", "setgid", "setgroups", "setpgid", "setpriority",
        "setregid", "setresgid", "setresuid", "setreuid", "setrlimit", "setsid",
        "setsockopt", "setuid", "shutdown", "sigaltstack", "socket", "socketpair",
        "splice", "stat", "statfs", "statx", "sync", "sync_file_range", "syncfs",
        "sysinfo", "tee", "tgkill", "time", "timer_create", "timer_delete",
        "timer_getoverrun", "timer_gettime", "timer_gettime64", "timer_settime",
        "timer_settime64", "timerfd_create", "timerfd_gettime",
        "timerfd_gettime64", "timerfd_settime", "timerfd_settime64", "times",
        "tkill", "truncate", "umask", "uname", "unlink", "unlinkat", "utime",
        "utimensat", "utimes", "vfork", "vmsplice", "wait4", "waitid", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

- [ ] **Step 2: Verify Seccomp JSON loads cleanly**

Run: `node -e "const p = JSON.parse(require('fs').readFileSync('overleaf/services/clsi/seccomp/clsi-profile.json')); console.log('Seccomp action:', p.defaultAction, 'Syscalls count:', p.syscalls[0].names.length);"`
Expected output: `Seccomp action: SCMP_ACT_ERRNO Syscalls count: 147`

---

### Task 2: Implement CLSI `DockerRunner.js`

**Files:**
- Create: `overleaf/services/clsi/app/js/DockerRunner.js`
- Test: `overleaf/services/clsi/test/unit/js/DockerRunner.test.js`

**Interfaces:**
- Consumes: `@overleaf/settings`, `@overleaf/logger`, `dockerode`, `./LastProjectAccess.js`, `./Errors.js`.
- Produces: `run()`, `kill()`, `destroyOldContainers()`, `canRunSyncTeXInOutputDir()`, `promises`.

- [ ] **Step 1: Inspect the unit test suite to verify baseline**

Run: `cd overleaf/services/clsi && yarn test:unit test/unit/js/DockerRunner.test.js`
Expected: Fails with `Cannot find module './DockerRunner.js'`

- [ ] **Step 2: Implement `services/clsi/app/js/DockerRunner.js`**

Implement the full `DockerRunner` module adhering to all specifications in `DockerRunner.test.js`:
- Path translation from internal container compile dir to host dir (`Settings.clsi.docker.hostDirCompiles`).
- Command replacement for `$COMPILE_DIR` with `/compile`.
- Dynamic container naming: `project-${projectId}-${fingerprint}`.
- Dockerode container lifecycle: `inspect`, `create`, `attach`, `start`, `wait`.
- Error handling: HTTP 500 retry logic.
- Timeouts: `container.kill()` and `{ timedout: true }` output.
- Garbage collection: `destroyOldContainers` with `LastProjectAccess` timestamp checks.
- Promisified interface via `util.promisify`.

- [ ] **Step 3: Run the 1,151-line unit test suite**

Run: `cd overleaf/services/clsi && yarn test:unit test/unit/js/DockerRunner.test.js`
Expected: All tests pass (100% green).

---

### Task 3: Wire Multi-Version TeX Live in `server-ce/config/settings.js`

**Files:**
- Modify: `overleaf/server-ce/config/settings.js`

**Interfaces:**
- Consumes: `process.env.ALL_TEX_LIVE_DOCKER_IMAGES`, `process.env.ALL_TEX_LIVE_DOCKER_IMAGE_NAMES`, `process.env.TEX_LIVE_DOCKER_IMAGE`.
- Produces: `settings.allowedImageNames`, `settings.currentImageName`.

- [ ] **Step 1: Add image parsing logic to `server-ce/config/settings.js`**

Add right after line 273:
```javascript
  currentImageName: process.env.TEX_LIVE_DOCKER_IMAGE,
```
The parsing logic:
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
```

- [ ] **Step 2: Run verification test on `settings.js`**

Run: `ALL_TEX_LIVE_DOCKER_IMAGES="sharelatex/texlive-full:2024.1,sharelatex/texlive-full:2023.1" ALL_TEX_LIVE_DOCKER_IMAGE_NAMES="TeX Live 2024,TeX Live 2023" node -e "const s = require('./overleaf/server-ce/config/settings.js'); console.log(JSON.stringify(s.allowedImageNames));"`
Expected: `[{"imageName":"sharelatex/texlive-full:2024.1","imageDesc":"TeX Live 2024"},{"imageName":"sharelatex/texlive-full:2023.1","imageDesc":"TeX Live 2023"}]`

---

### Task 4: Create `server-ce/Dockerfile.slim`

**Files:**
- Create: `overleaf/server-ce/Dockerfile.slim`

**Interfaces:**
- Consumes: `$OVERLEAF_BASE_TAG`, `server-ce/genScript.js`, `server-ce/runit/`, `server-ce/config/`.
- Produces: Production lean control-plane container image (~1.5GB).

- [ ] **Step 1: Create `server-ce/Dockerfile.slim`**

Copy `server-ce/Dockerfile` template and remove the `tlmgr install scheme-full` layer, leaving only essential control-plane system utilities and node service build steps.

- [ ] **Step 2: Validate Dockerfile syntax**

Run: `docker build --check -f overleaf/server-ce/Dockerfile.slim overleaf/` or validate syntax.

---

### Task 5: Full Test Suite Verification

**Files:**
- Test: All CLSI unit tests in `overleaf/services/clsi/test/unit/js/`

- [ ] **Step 1: Run all unit tests in CLSI**

Run: `cd overleaf/services/clsi && yarn test:unit`
Expected: All test suites (`DockerRunner.test.js`, `CommandRunner.test.js`, `ConversionManager.test.js`, `CompileManager.test.js`, etc.) pass.

- [ ] **Step 2: Run linter on modified files**

Run: `cd overleaf && yarn eslint services/clsi/app/js/DockerRunner.js server-ce/config/settings.js`
Expected: 0 lint errors.
