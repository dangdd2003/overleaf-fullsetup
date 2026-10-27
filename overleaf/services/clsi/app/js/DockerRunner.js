import Docker from 'dockerode'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import crypto from 'node:crypto'
import Path from 'node:path'
import util from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import OError from '@overleaf/o-error'
import * as LastProjectAccessModule from './LastProjectAccess.js'
import * as AutoPullManager from './AutoPullManager.js'
import Errors from './Errors.js'

const LastProjectAccess = LastProjectAccessModule.getLastProjectAccessTime
  ? LastProjectAccessModule
  : LastProjectAccessModule.default || LastProjectAccessModule

let dockerClient
let detectedMounts = null
// compileName -> Set of in-flight runs (compile, synctex, wordcount, ...)
const activeCompiles = new Map()
// containerName -> in-flight run, used for kill checks during start/wait
const runningContainers = new Map()
// containerName -> queued runs, so two runs never drive the same container
const containerQueues = new Map()

function trackCompile(projectId, entry) {
  let entries = activeCompiles.get(projectId)
  if (!entries) {
    entries = new Set()
    activeCompiles.set(projectId, entries)
  }
  entries.add(entry)
}

function untrackCompile(projectId, entry) {
  const entries = activeCompiles.get(projectId)
  if (!entries) return
  entries.delete(entry)
  if (entries.size === 0) activeCompiles.delete(projectId)
}

function runExclusive(name, fn, callback) {
  let done = false
  const release = (...args) => {
    if (done) return
    done = true
    const queue = containerQueues.get(name)
    queue.shift()
    if (queue.length > 0) {
      process.nextTick(queue[0])
    } else {
      containerQueues.delete(name)
    }
    callback(...args)
  }
  const job = () => {
    try {
      fn(release)
    } catch (err) {
      release(err)
    }
  }
  const queue = containerQueues.get(name)
  if (queue) {
    queue.push(job)
    return
  }
  containerQueues.set(name, [job])
  job()
}

// Docker calls other than wait/attach streams return quickly; bound them so a
// stalled daemon fails the compile instead of holding its lock forever.
const DOCKER_CALL_TIMEOUT_MS = 60 * 1000
// Grace period for trailing output after the container exited
const STREAM_END_TIMEOUT_MS = 2 * 1000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
// head and tail each keep half of the cap; the middle of a huge log is dropped
const OUTPUT_HALF_BYTES = MAX_OUTPUT_BYTES / 2

function newOutputBuffer() {
  return { head: [], headBytes: 0, tail: [], tailBytes: 0, dropped: 0 }
}

// Chunks are kept as Buffers and decoded once in renderOutput, so a multibyte
// character split across chunks is decoded correctly and nothing is re-copied.
function appendOutput(buf, chunk) {
  let b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  if (buf.headBytes < OUTPUT_HALF_BYTES) {
    const cut = Math.min(OUTPUT_HALF_BYTES - buf.headBytes, b.length)
    buf.head.push(b.subarray(0, cut))
    buf.headBytes += cut
    b = b.subarray(cut)
    if (b.length === 0) return
  }
  buf.tail.push(b)
  buf.tailBytes += b.length
  let excess = buf.tailBytes - OUTPUT_HALF_BYTES
  while (excess > 0) {
    const first = buf.tail[0]
    if (first.length <= excess) {
      buf.tail.shift()
      excess -= first.length
      buf.tailBytes -= first.length
      buf.dropped += first.length
    } else {
      buf.tail[0] = first.subarray(excess)
      buf.tailBytes -= excess
      buf.dropped += excess
      excess = 0
    }
  }
}

function renderOutput(buf) {
  const parts = [Buffer.concat(buf.head)]
  if (buf.dropped > 0) {
    parts.push(
      Buffer.from(`\n[... ${buf.dropped} bytes of output omitted ...]\n`)
    )
  }
  parts.push(Buffer.concat(buf.tail))
  return Buffer.concat(parts).toString('utf8')
}

function withDeadline(label, fn, callback) {
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    const err = new Error(`docker ${label} timed out`)
    err.dockerTimeout = true
    callback(err)
  }, DOCKER_CALL_TIMEOUT_MS)
  const settle = (err, ...rest) => {
    if (settled) {
      // late attach: nobody reads it, close the hijacked connection
      if (typeof rest[0]?.destroy === 'function') rest[0].destroy()
      return
    }
    settled = true
    clearTimeout(timer)
    callback(err, ...rest)
  }
  try {
    fn(settle)
  } catch (err) {
    settle(err)
  }
}

// True when clsi itself runs in a container (docker or podman), where compile
// dirs need a host path translation. Never throws: a throw here would be
// swallowed by withDeadline and leave the compile without a callback.
function isInsideContainer() {
  try {
    return (
      fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')
    )
  } catch (err) {
    return false
  }
}

// The id of the container clsi runs in. The hostname is only the container
// id when no custom hostname is set, so prefer the id docker puts in the
// source paths of the /etc/hostname, /etc/hosts and /etc/resolv.conf mounts.
// Only read inside a container: a host's mountinfo lists the mounts of every
// container on it.
function ownContainerId() {
  if (isInsideContainer()) {
    try {
      const match = fs
        .readFileSync('/proc/self/mountinfo', 'utf8')
        .match(
          /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf) \/etc\//
        )
      if (match) return match[1]
    } catch (err) {}
  }
  return os.hostname()
}

// Mounts of the container this clsi runs in, used to translate compile dirs
// into host paths for the sibling containers. Only a successful lookup is
// cached: caching a failed one would bind non-existent host paths (docker
// creates them empty) for every compile until the process restarts.
function getDetectedMounts(callback) {
  if (detectedMounts) return callback(null, detectedMounts)
  let container
  try {
    container = DockerRunner._getDocker().getContainer(ownContainerId())
  } catch (err) {
    logger.warn({ err }, 'could not look up own container for host paths')
    return callback(null, {})
  }
  if (!container || typeof container.inspect !== 'function') {
    return callback(null, {})
  }
  withDeadline(
    'inspect self',
    cb => container.inspect(cb),
    (err, data) => {
      if (err && err.statusCode === 404 && !isInsideContainer()) {
        // not running inside a container, compile dirs are host paths
        detectedMounts = {}
        return callback(null, detectedMounts)
      }
      // A 404 inside a container means the id lookup failed (e.g. podman or
      // a foreign mount layout). That is not cached: it must not turn into
      // "no mounts" for the rest of the process lifetime.
      if (err || !Array.isArray(data?.Mounts)) {
        logger.warn(
          { err, containerId: ownContainerId() },
          'could not inspect own container for host paths, retrying on next compile'
        )
        return callback(err || new Error('no mounts in container inspect'))
      }
      const mounts = {}
      for (const m of data.Mounts) {
        if (m.Destination && m.Source) {
          mounts[m.Destination] = m.Source
        }
      }
      detectedMounts = mounts
      callback(null, detectedMounts)
    }
  )
}

function replacePrefix(path, prefix, replacement) {
  // function replacement, so that `$` in host paths is taken literally
  return path.replace(prefix, () => replacement)
}

// Roots that exist inside the clsi container only (never on the docker host).
const CONTAINER_ONLY_ROOTS = [
  '/var/lib/overleaf/',
  '/var/lib/sharelatex/',
  '/local/compile/',
]
function isContainerOnlyPath(p) {
  return CONTAINER_ONLY_ROOTS.some(root => p.startsWith(root))
}

// Only chmod when the mode is wrong, so trees that are already writable are
// not rewritten on every compile. statSync follows a symlink, as chmodSync
// does, so the top-level directory behaves as before.
function ensureMode(p, mode) {
  if ((fs.statSync(p).mode & 0o777) !== mode) fs.chmodSync(p, mode)
}

// The tex user in the image is not the owner of the files clsi writes, so the
// whole tree (including subdirectories of included files) must be writable.
// Symlinked entries inside the tree are not followed.
function makeWritable(directory) {
  ensureMode(directory, 0o777)
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const p = Path.join(directory, entry.name)
    try {
      if (entry.isDirectory()) {
        makeWritable(p)
      } else if (entry.isFile()) {
        ensureMode(p, 0o666)
      }
    } catch (e) {}
  }
}

function resolveHostPath(containerPath, mounts) {
  if (!containerPath || !mounts) return null
  let bestMatch = null
  let bestDestLen = 0
  for (const [dest, source] of Object.entries(mounts)) {
    if (containerPath === dest) return source
    if (containerPath.startsWith(dest.endsWith('/') ? dest : dest + '/')) {
      if (dest.length > bestDestLen) {
        bestDestLen = dest.length
        bestMatch = { dest, source }
      }
    }
  }
  if (bestMatch) {
    const rel = containerPath.slice(bestMatch.dest.length).replace(/^\/+/, '')
    return Path.join(bestMatch.source, rel)
  }
  return null
}

const DockerRunner = {
  _getDocker() {
    if (!dockerClient) {
      dockerClient = new Docker(Settings.clsi?.docker?.clientConfig || {})
    }
    return dockerClient
  },
  MAX_CONTAINER_AGE:
    Settings.clsi?.expireProjectAfterIdleMs || 24 * 60 * 60 * 1000,
  CONTAINER_POLL_INTERVAL: Settings.clsi?.checkProjectsIntervalMs || 60 * 1000,
  _containerMonitorInterval: null,

  canRunSyncTeXInOutputDir() {
    return true
  },

  startContainerMonitor() {
    if (this._containerMonitorInterval) return
    this._containerMonitorInterval = setInterval(() => {
      this.destroyOldContainers(err => {
        if (err) {
          logger.warn({ err }, 'error destroying old containers in monitor')
        }
      })
    }, this.CONTAINER_POLL_INTERVAL)
  },

  stopContainerMonitor() {
    if (this._containerMonitorInterval) {
      clearInterval(this._containerMonitorInterval)
      this._containerMonitorInterval = null
    }
    activeCompiles.clear()
  },

  run(
    projectId,
    command,
    directory,
    image,
    timeout,
    env,
    compileGroup,
    cwd,
    callback
  ) {
    this.startContainerMonitor()
    if (typeof cwd === 'function') {
      callback = cwd
      cwd = null
    }

    const compileEntry = { containerName: null, killed: false }
    trackCompile(projectId, compileEntry)
    const done = (err, output) => {
      untrackCompile(projectId, compileEntry)
      callback(err, output)
    }

    const defaultImage =
      Settings.clsi?.docker?.image || 'sharelatex/texlive-full:latest'
    let selectedImage = image || defaultImage

    // the png2pdf helper is clsi's own configured image, never listed in
    // allowedImages; only that exact image is exempt
    const isPng2pdfRun =
      compileGroup === 'png2pdf' && selectedImage === Settings.png2pdfImage
    if (
      !isPng2pdfRun &&
      Array.isArray(Settings.clsi?.docker?.allowedImages) &&
      Settings.clsi.docker.allowedImages.length > 0
    ) {
      if (!Settings.clsi.docker.allowedImages.includes(selectedImage)) {
        return done(new Errors.InvalidParameter('image not allowed'))
      }
    }

    // allowedImages lists the canonical names, so the registry override is
    // applied after validation (as in Server Pro)
    selectedImage = AutoPullManager.resolveImageName(selectedImage)

    getDetectedMounts((mountsErr, mounts) => {
      // Not fatal by itself: explicit SANDBOXED_COMPILES_HOST_DIR_* mappings
      // still work, and the refusal below covers directories that stay
      // untranslated inside a container.
      if (mountsErr) {
        logger.warn(
          { err: mountsErr },
          'could not inspect own container, relying on explicit host dirs'
        )
      }
      const mountTable = mountsErr ? {} : mounts
      const detectedCompiles =
        resolveHostPath('/var/lib/overleaf/data/compiles', mountTable) ||
        resolveHostPath(Settings.path?.compilesDir, mountTable) ||
        resolveHostPath('/var/lib/sharelatex/data/compiles', mountTable)
      const detectedOutput =
        resolveHostPath('/var/lib/overleaf/data/output', mountTable) ||
        resolveHostPath(Settings.path?.outputDir, mountTable) ||
        resolveHostPath('/var/lib/sharelatex/data/output', mountTable)

      // Build volume mapping and translate host directory
      const hostCompilesDir =
        Settings.path?.sandboxedCompilesHostDirCompiles ||
        detectedCompiles ||
        Settings.path?.compilesDir ||
        '/var/lib/overleaf/data/compiles'
      const hostOutputDir =
        Settings.path?.sandboxedCompilesHostDirOutput ||
        detectedOutput ||
        Settings.path?.outputDir ||
        '/var/lib/overleaf/data/output'

      let hostDirectory = directory
      let isReadOnly = false

      if (compileGroup === 'synctex-output') {
        isReadOnly = true
        if (directory.startsWith('/var/lib/overleaf/data/output')) {
          hostDirectory = replacePrefix(
            directory,
            '/var/lib/overleaf/data/output',
            hostOutputDir
          )
        } else if (directory.startsWith('/local/compile/directory')) {
          hostDirectory = replacePrefix(
            directory,
            '/local/compile/directory',
            hostOutputDir + '/directory'
          )
        }
      } else if (compileGroup === 'synctex' || compileGroup === 'wordcount') {
        isReadOnly = true
        if (directory.startsWith('/var/lib/overleaf/data/compile')) {
          hostDirectory = replacePrefix(
            directory,
            /^\/var\/lib\/overleaf\/data\/compiles?/,
            hostCompilesDir
          )
        } else if (directory.startsWith('/local/compile/directory')) {
          hostDirectory = replacePrefix(
            directory,
            '/local/compile/directory',
            hostCompilesDir + '/directory'
          )
        }
      } else if (compileGroup === 'conversions') {
        isReadOnly = false
        if (directory.startsWith('/var/lib/overleaf/data/compile')) {
          hostDirectory = replacePrefix(
            directory,
            /^\/var\/lib\/overleaf\/data\/compiles?/,
            hostCompilesDir
          )
        } else if (directory.startsWith('/local/compile/directory')) {
          hostDirectory = replacePrefix(
            directory,
            '/local/compile/directory',
            hostCompilesDir + '/directory'
          )
        }
      } else {
        if (directory.startsWith('/var/lib/overleaf/data/compiles')) {
          hostDirectory = replacePrefix(
            directory,
            '/var/lib/overleaf/data/compiles',
            hostCompilesDir
          )
        } else if (directory.startsWith('/local/compile/directory')) {
          hostDirectory = replacePrefix(
            directory,
            '/local/compile/directory',
            hostCompilesDir + '/directory'
          )
        }
      }

      const cacheDir = Settings.path?.clsiCacheDir
      if (
        Settings.path?.sandboxedCompilesHostDirCache &&
        cacheDir &&
        directory.startsWith(cacheDir + '/')
      ) {
        hostDirectory = replacePrefix(
          directory,
          cacheDir,
          Settings.path.sandboxedCompilesHostDirCache
        )
      }

      // Without an explicit host dir, the mount of this container gives the
      // host path. An explicit SANDBOXED_COMPILES_HOST_DIR_* always wins.
      // Decided per directory: an explicit mapping only counts when the
      // directory's own prefix was mapped by a setting.
      const directResolved = resolveHostPath(directory, mountTable)
      const explicitMapped = Boolean(
        (Settings.path?.sandboxedCompilesHostDirCache &&
          cacheDir &&
          directory.startsWith(cacheDir + '/')) ||
          (Settings.path?.sandboxedCompilesHostDirOutput &&
            directory.startsWith('/var/lib/overleaf/data/output')) ||
          (Settings.path?.sandboxedCompilesHostDirCompiles &&
            (directory.startsWith('/var/lib/overleaf/data/compile') ||
              directory.startsWith('/local/compile/directory')))
      )
      if (!explicitMapped && directResolved) {
        hostDirectory = directResolved
      }

      // Inside a container, an untranslated path does not exist on the host:
      // docker would bind a fresh empty dir and the compile would fail with no
      // output. Refuse instead, with the setting that fixes it. When the own
      // container could not be inspected, the translation falls back to the
      // container-side compiles/output dirs, which is still untranslated.
      const untranslated =
        hostDirectory === directory ||
        (mountsErr && isContainerOnlyPath(hostDirectory))
      if (
        untranslated &&
        !directResolved &&
        !explicitMapped &&
        isInsideContainer()
      ) {
        return done(
          new OError(
            'could not map compile directory to a host path, set SANDBOXED_COMPILES_HOST_DIR_COMPILES (and _OUTPUT / _CACHE) to the host path of the volume',
            {
              directory,
              hostname: os.hostname(),
              inspectError: mountsErr ? mountsErr.message : undefined,
            }
          )
        )
      }

      if (!isReadOnly && directory && compileGroup !== 'png2pdf') {
        try {
          makeWritable(directory)
        } catch (err) {
          logger.warn({ err, directory }, 'could not chmod compile directory')
        }
      }

      const mountTarget = isReadOnly ? '/compile:ro' : '/compile'
      const volumes = { [hostDirectory]: mountTarget }

      const commandWithDir = command.map(arg => {
        if (typeof arg === 'string') {
          return arg.replace(/\$COMPILE_DIR/g, '/compile')
        }
        return arg
      })

      const options = this._getContainerOptions(
        commandWithDir,
        selectedImage,
        volumes,
        timeout,
        env,
        compileGroup,
        cwd
      )

      const fingerprint = this._fingerprintContainer(options)
      const containerName = `sandbox-compiler-${projectId}-${fingerprint}`
      options.name = containerName
      options.projectId = projectId

      compileEntry.containerName = containerName
      if (compileEntry.killed) {
        const err = new Error('terminated')
        err.terminated = true
        return done(err)
      }

      runExclusive(
        containerName,
        release => {
          runningContainers.set(containerName, compileEntry)
          const finish = (err, output) => {
            runningContainers.delete(containerName)
            release(err, output)
            // AutoRemove runs (synctex, wordcount, ...) must not remove the
            // reusable compile container
            if (!err && options.HostConfig?.AutoRemove !== true) {
              this._pruneSiblingContainers(projectId, containerName)
            }
          }
          const executeWithRetry = (isRetry = false) => {
            if (compileEntry.killed) {
              const err = new Error('terminated')
              err.terminated = true
              return finish(err)
            }
            this._runAndWaitForContainer(
              options,
              volumes,
              timeout,
              (err, output) => {
                if (err && err.statusCode === 500 && !isRetry) {
                  logger.warn(
                    { err, containerName, projectId },
                    'HTTP 500 from docker daemon, destroying container and retrying once'
                  )
                  return this.destroyContainer(
                    containerName,
                    null,
                    false,
                    () => {
                      executeWithRetry(true)
                    }
                  )
                }
                finish(err, output)
              }
            )
          }
          executeWithRetry(false)
        },
        done
      )
    })
    return projectId
  },

  _getContainerOptions(
    command,
    image,
    volumes,
    timeout,
    env = {},
    compileGroup = 'standard',
    cwd = null
  ) {
    const binds = []
    for (const [hostPath, containerPath] of Object.entries(volumes || {})) {
      if (containerPath.endsWith(':ro') || containerPath.endsWith(':rw')) {
        binds.push(`${hostPath}:${containerPath}`)
      } else {
        binds.push(`${hostPath}:${containerPath}:rw`)
      }
    }

    const securityOpts = ['no-new-privileges']
    // settings.defaults writes seccomp_profile as JSON text, which docker takes
    // as-is (seccomp=<json>); it must not be JSON-encoded a second time
    const seccompProfile =
      Settings.clsi?.docker?.seccomp_profile ||
      Settings.clsi?.docker?.seccompProfile
    if (seccompProfile) {
      const profileJson =
        typeof seccompProfile === 'string'
          ? seccompProfile
          : JSON.stringify(seccompProfile)
      securityOpts.push(`seccomp=${profileJson}`)
    }

    const hostConfig = {
      Binds: binds,
      LogConfig: { Type: 'none', Config: {} },
      // compiles only read and write their bind mounts: no network access
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      SecurityOpt: securityOpts,
    }

    const envMap = {
      HOME: '/tmp',
      CLSI: '1',
      ...(Settings.clsi?.docker?.env || {}),
      ...(env || {}),
    }

    const envArray = Object.entries(envMap).map(([key, val]) => `${key}=${val}`)

    const workingDir = cwd ? Path.posix.join('/compile', cwd) : '/compile'

    const options = {
      Image: image,
      Cmd: command,
      User: Settings.clsi?.docker?.user || 'tex',
      WorkingDir: workingDir,
      Env: envArray,
      HostConfig: hostConfig,
    }

    // compileGroupConfig comes from the deployment admin (COMPILE_GROUP_DOCKER_CONFIGS),
    // never from a client. Only SecurityOpt and CapDrop are merged with the
    // sandbox defaults; any other HostConfig key (NetworkMode, Privileged,
    // Binds, PidMode, ...) replaces the default outright, so the admin owns
    // those choices.
    const groupConfig =
      Settings.clsi?.docker?.compileGroupConfig?.[compileGroup]
    if (groupConfig) {
      for (const [key, value] of Object.entries(groupConfig)) {
        if (key.startsWith('HostConfig.')) {
          const prop = key.slice('HostConfig.'.length)
          // the sandbox entries are enforced: an override adds to them and
          // can never drop or replace seccomp, no-new-privileges or CapDrop ALL
          if (prop === 'SecurityOpt' || prop === 'CapDrop') {
            const extra = (Array.isArray(value) ? value : []).filter(
              v =>
                !(
                  prop === 'SecurityOpt' &&
                  (v.startsWith('seccomp') || v.startsWith('no-new-privileges'))
                )
            )
            options.HostConfig[prop] = [
              ...new Set([...(options.HostConfig[prop] || []), ...extra]),
            ]
          } else {
            options.HostConfig[prop] = value
          }
        } else {
          options[key] = value
        }
      }
    }

    return options
  },

  _fingerprintContainer(options) {
    // Existing containers are restarted as they are, so everything that goes
    // into the container must be part of its name, or a later run would
    // execute the previous command/env.
    const relevant = {
      Image: options.Image,
      Cmd: options.Cmd,
      Env: options.Env,
      User: options.User,
      WorkingDir: options.WorkingDir,
      HostConfig: options.HostConfig,
    }
    return crypto
      .createHash('md5')
      .update(JSON.stringify(relevant))
      .digest('hex')
  },

  _runAndWaitForContainer(options, volumes, timeout, callback) {
    const compileEntry = runningContainers.get(options.name)
    const out = { stdout: newOutputBuffer(), stderr: newOutputBuffer() }
    let capturedOutput = { stdout: '', stderr: '' }
    let stream = null
    let streamEnded = false
    let finished = false
    const isAborted = () => compileEntry?.killed === true

    const attachStreamHandler = (err, attached) => {
      if (err || !attached) return
      if (typeof attached.on !== 'function') {
        capturedOutput = attached
        return
      }
      stream = attached
      stream.on('end', () => {
        streamEnded = true
      })
      stream.on('close', () => {
        streamEnded = true
      })
      stream.on('error', err => {
        streamEnded = true
        logger.warn({ err, name: options.name }, 'error on container stream')
      })
      const modem = this._getDocker().modem
      if (typeof modem?.demuxStream === 'function') {
        // non-tty attach streams are multiplexed (8 byte frame headers)
        modem.demuxStream(
          stream,
          { write: chunk => appendOutput(out.stdout, chunk) },
          { write: chunk => appendOutput(out.stderr, chunk) }
        )
      } else {
        stream.on('data', chunk => appendOutput(out.stdout, chunk))
      }
    }

    const terminated = () => {
      const termErr = new Error('terminated')
      termErr.terminated = true
      return termErr
    }

    // wait for trailing output, then always close the attach connection
    const finish = (err, result) => {
      if (finished) return
      finished = true
      if (compileEntry) compileEntry.abort = null
      if (err) {
        // the container may still be running unsupervised (start/kill
        // deadline, kill before start); never let a later run reattach to it
        return this._destroyContainer(options.name, true, () =>
          drain(err, result)
        )
      }
      drain(err, result)
    }
    const drain = (err, result) => {
      let called = false
      const complete = () => {
        if (called) return
        called = true
        clearTimeout(timer)
        if (stream && typeof stream.destroy === 'function') stream.destroy()
        // rendered here, after the grace period, so trailing output is kept
        callback(err, typeof result === 'function' ? result() : result)
      }
      const timer =
        stream && !streamEnded
          ? setTimeout(complete, STREAM_END_TIMEOUT_MS)
          : null
      if (!timer) return complete()
      stream.once('end', complete)
      stream.once('close', complete)
    }

    const collectOutput = exitCode => {
      if (!stream) {
        capturedOutput.exitCode = exitCode
        return capturedOutput
      }
      return {
        stdout: renderOutput(out.stdout),
        stderr: renderOutput(out.stderr),
        exitCode,
      }
    }

    // kill() must not wait for an image pull inside startContainer (it can take
    // minutes). Only the pull is abortable: no container exists yet, so nothing
    // is destroyed, and the late pull result is dropped by the finished flag.
    // Outside the pull, the lock is held until the docker calls settle.
    const abortPull = () => {
      if (finished) return
      finished = true
      process.nextTick(() => drain(terminated(), null))
    }
    const onPull = active => {
      if (compileEntry) compileEntry.abort = active ? abortPull : null
    }

    this.startContainer(
      options,
      volumes,
      attachStreamHandler,
      (err, containerId) => {
        if (err) return finish(err)

        // the kill arrived before the container existed
        if (isAborted()) return finish(terminated())

        this.waitForContainer(
          options.name || containerId,
          timeout,
          options,
          (waitErr, exitCode) => {
            if (isAborted()) return finish(terminated())
            if (waitErr) return finish(waitErr)
            finish(null, () => collectOutput(exitCode))
          }
        )
      },
      false,
      isAborted,
      onPull
    )
  },

  startContainer(
    options,
    volumes,
    attachStreamHandler,
    callback,
    pulled,
    isAborted = () => false,
    onPull = () => {}
  ) {
    const docker = this._getDocker()
    const container = docker.getContainer(options.name)

    const attachAndStart = (target, id) => {
      this.attachToContainer(options.name, attachStreamHandler, attachErr => {
        if (attachErr) return callback(attachErr)
        withDeadline(
          'start',
          cb => target.start(cb),
          startErr => {
            if (startErr && startErr.statusCode !== 304) {
              return callback(startErr)
            }
            callback(null, id || options.name)
          }
        )
      })
    }

    withDeadline(
      'inspect',
      cb => container.inspect(cb),
      (err, info) => {
        if (err && err.statusCode === 404) {
          // Container does not exist, create it
          withDeadline(
            'create',
            cb => docker.createContainer(options, cb),
            (createErr, newContainer) => {
              if (createErr) {
                if (
                  !pulled &&
                  createErr.statusCode === 404 &&
                  createErr.message?.includes('No such image') &&
                  process.env.TEX_LIVE_AUTO_PULL_ENABLED === 'true'
                ) {
                  logger.info(
                    { image: options.Image },
                    '[AutoPull] Image not found locally during compile. Pulling on demand...'
                  )
                  // killed before the pull: do not pull or create the container
                  if (isAborted()) {
                    const err = new Error('terminated')
                    err.terminated = true
                    return callback(err)
                  }
                  onPull(true)
                  return AutoPullManager.pullImage(options.Image).then(
                    () => {
                      onPull(false)
                      // killed while pulling: do not create the container now
                      if (isAborted()) {
                        const err = new Error('terminated')
                        err.terminated = true
                        return callback(err)
                      }
                      this.startContainer(
                        options,
                        volumes,
                        attachStreamHandler,
                        callback,
                        true,
                        isAborted,
                        onPull
                      )
                    },
                    pullErr => {
                      onPull(false)
                      logger.error(
                        { pullErr, image: options.Image },
                        '[AutoPull] On-demand pull failed'
                      )
                      callback(createErr)
                    }
                  ).catch(err => {
                    logger.error(
                      { err },
                      '[AutoPull] error after on-demand pull'
                    )
                  })
                }
                return callback(createErr)
              }
              attachAndStart(newContainer, newContainer.id)
            }
          )
        } else if (!err || err.statusCode === 304) {
          // Container exists
          attachAndStart(container, container.id)
        } else {
          callback(err)
        }
      }
    )
  },

  attachToContainer(containerId, attachStreamHandler, callback) {
    const docker = this._getDocker()
    const container = docker.getContainer(containerId)
    withDeadline(
      'attach',
      cb =>
        container.attach({ stream: true, stdout: true, stderr: true }, cb),
      (err, stream) => {
        if (err) return callback(err)
        if (attachStreamHandler) {
          attachStreamHandler(null, stream)
        }
        callback(null)
      }
    )
  },

  waitForContainer(containerId, timeout, options, callback) {
    const docker = this._getDocker()
    const container = docker.getContainer(containerId)
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      withDeadline(
        'kill',
        cb => container.kill(cb),
        () => {
          const error = new Error('container timed out')
          error.timedout = true
          callback(error)
        }
      )
    }, timeout)

    container.wait((err, data) => {
      clearTimeout(timer)
      if (timedOut) return

      if (err) {
        if (
          err.statusCode === 404 &&
          options?.HostConfig?.AutoRemove === true
        ) {
          return callback(null, 0)
        }
        return callback(err)
      }

      callback(null, data?.StatusCode ?? 0)
    })
  },

  destroyOldContainers(callback) {
    const docker = this._getDocker()
    const nowInSeconds = Date.now() / 1000
    const maxAgeInSeconds = this.MAX_CONTAINER_AGE / 1000

    docker.listContainers({ all: true }, (err, containers) => {
      if (err) return callback(err)
      if (!Array.isArray(containers)) return callback(null)

      const toDestroy = containers.filter(c => {
        const rawName = c.Names?.[0] || c.Name || ''
        const name = rawName.replace(/^\//, '')
        if (
          !name.startsWith('sandbox-compiler-') &&
          !name.startsWith('project-')
        )
          return false

        const match =
          name.match(/^sandbox-compiler-(.+)-[a-f0-9]{32}$/) ||
          name.match(/^project-([a-f0-9]+)-/)
        if (!match) return false
        const projectId = match[1]

        const lastAccess = LastProjectAccess.getLastProjectAccessTime(projectId)
        if (lastAccess && Date.now() - lastAccess < this.MAX_CONTAINER_AGE) {
          return false
        }

        const ageInSeconds = nowInSeconds - (c.Created || 0)
        return ageInSeconds > maxAgeInSeconds
      })

      let remaining = toDestroy.length
      if (remaining === 0) return callback(null)

      let firstErr = null
      for (const c of toDestroy) {
        const rawName = c.Names?.[0] || c.Name || ''
        const name = rawName.replace(/^\//, '')
        // queued like a run on that container, so a compile that is starting
        // on it cannot have the container removed under it
        runExclusive(
          name,
          release => {
            if (runningContainers.has(name)) return release()
            this._destroyContainer(c.Id || name, false, release)
          },
          destroyErr => {
            if (destroyErr && !firstErr) firstErr = destroyErr
            remaining--
            if (remaining === 0) {
              callback(firstErr)
            }
          }
        )
      }
    })
  },

  // Every distinct command/env gets its own container per project. After a
  // successful compile, the stopped siblings are removed. Containers with a
  // queued or running run are skipped, and binds are never removed.
  _pruneSiblingContainers(projectId, keepName) {
    const prefix = `sandbox-compiler-${projectId}-`
    // exact match, so a project-level compile never prunes per-user ones
    const isSibling = name =>
      name.startsWith(prefix) &&
      /^[a-f0-9]{32}$/.test(name.slice(prefix.length))
    this._getDocker().listContainers(
      { all: true, filters: { name: [prefix] } },
      (err, containers) => {
        if (err || !Array.isArray(containers)) return
        for (const c of containers) {
          const name = (c.Names?.[0] || '').replace(/^\//, '')
          if (!isSibling(name) || name === keepName) continue
          if (c.State !== 'exited' || containerQueues.has(name)) continue
          // queued like a run on that container, so a run started meanwhile
          // either finishes first or recreates the container afterwards
          runExclusive(
            name,
            release => {
              if (runningContainers.has(name)) return release()
              this._destroyContainer(name, false, release)
            },
            destroyErr => {
              if (destroyErr) {
                logger.warn(
                  { err: destroyErr, name },
                  'could not prune container'
                )
              }
            }
          )
        }
      }
    )
  },

  destroyContainer(name, id, shouldForce, callback) {
    if (typeof shouldForce === 'function') {
      callback = shouldForce
      shouldForce = false
    }
    this._destroyContainer(name || id, Boolean(shouldForce), callback)
  },

  _destroyContainer(containerId, shouldForce, callback) {
    const docker = this._getDocker()
    const container = docker.getContainer(containerId)
    withDeadline(
      'remove',
      cb => container.remove({ force: Boolean(shouldForce), v: true }, cb),
      err => {
        if (err && err.statusCode === 404) {
          return callback(null)
        }
        callback(err || null)
      }
    )
  },

  kill(identifier, callback) {
    if (typeof callback !== 'function') callback = () => {}
    const containerIds = new Set()
    for (const entry of activeCompiles.get(identifier) || []) {
      entry.killed = true
      if (entry.containerName) containerIds.add(entry.containerName)
      if (entry.abort) entry.abort()
    }
    if (!activeCompiles.has(identifier)) containerIds.add(identifier)

    let remaining = containerIds.size
    if (remaining === 0) return process.nextTick(callback)
    let firstErr = null
    for (const containerId of containerIds) {
      const container = this._getDocker().getContainer(containerId)
      withDeadline(
        'kill',
        cb => container.kill(cb),
        err => {
          const ignore =
            err &&
            (err.statusCode === 404 || err.message?.includes('is not running'))
          if (err && !ignore && !firstErr) firstErr = err
          if (--remaining === 0) {
            process.nextTick(() =>
              firstErr ? callback(firstErr) : callback()
            )
          }
        }
      )
    }
  },
}

DockerRunner.promises = {
  run: util.promisify(DockerRunner.run.bind(DockerRunner)),
  kill: util.promisify(DockerRunner.kill.bind(DockerRunner)),
  destroyOldContainers: util.promisify(
    DockerRunner.destroyOldContainers.bind(DockerRunner)
  ),
}

export default DockerRunner
