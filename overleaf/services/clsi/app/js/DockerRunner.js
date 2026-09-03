import Docker from 'dockerode'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import metrics from '@overleaf/metrics'
import crypto from 'node:crypto'
import Path from 'node:path'
import util from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import * as LastProjectAccessModule from './LastProjectAccess.js'
import LockManager from './LockManager.js'

const LastProjectAccess =
  LastProjectAccessModule.getLastProjectAccessTime
    ? LastProjectAccessModule
    : LastProjectAccessModule.default || LastProjectAccessModule

let dockerClient
let detectedMounts = null

function getDocker() {
  if (!dockerClient) {
    dockerClient = new Docker(Settings.clsi?.docker?.clientConfig || {})
  }
  return dockerClient
}

function getDetectedMounts(callback) {
  if (detectedMounts) return callback(null, detectedMounts)
  try {
    const docker = getDocker()
    const container = docker.getContainer(os.hostname())
    container.inspect((err, data) => {
      detectedMounts = {}
      if (!err && data?.Mounts) {
        for (const m of data.Mounts) {
          if (m.Destination && m.Source) {
            detectedMounts[m.Destination] = m.Source
          }
        }
      }
      callback(null, detectedMounts)
    })
  } catch (err) {
    detectedMounts = {}
    callback(null, detectedMounts)
  }
}

const DockerRunner = {
  MAX_CONTAINER_AGE:
    Settings.clsi?.expireProjectAfterIdleMs || 24 * 60 * 60 * 1000,
  CONTAINER_POLL_INTERVAL:
    Settings.clsi?.checkProjectsIntervalMs || 60 * 1000,
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

    const defaultImage =
      Settings.clsi?.docker?.image || 'sharelatex/texlive-full:latest'
    let selectedImage = image || defaultImage

    if (Settings.texliveImageNameOveride) {
      const parts = selectedImage.split('/')
      const imageNameWithTag = parts[parts.length - 1]
      selectedImage = `${Settings.texliveImageNameOveride}/${imageNameWithTag}`
    }

    if (
      Array.isArray(Settings.clsi?.docker?.allowedImages) &&
      Settings.clsi.docker.allowedImages.length > 0
    ) {
      if (!Settings.clsi.docker.allowedImages.includes(selectedImage)) {
        return callback(new Error('image not allowed'))
      }
    }

    getDetectedMounts((_, mounts) => {
      const detectedCompiles =
        mounts?.['/var/lib/overleaf/data/compiles'] ||
        (mounts?.['/var/lib/overleaf/data']
          ? Path.join(mounts['/var/lib/overleaf/data'], 'compiles')
          : null)
      const detectedOutput =
        mounts?.['/var/lib/overleaf/data/output'] ||
        (mounts?.['/var/lib/overleaf/data']
          ? Path.join(mounts['/var/lib/overleaf/data'], 'output')
          : null)

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
          hostDirectory = directory.replace(
            '/var/lib/overleaf/data/output',
            hostOutputDir
          )
        } else if (directory.startsWith('/local/compile/directory')) {
          hostDirectory = directory.replace(
            '/local/compile/directory',
            hostOutputDir + '/directory'
          )
        }
      } else if (
        compileGroup === 'synctex' ||
        compileGroup === 'wordcount' ||
        compileGroup === 'conversions'
      ) {
        isReadOnly = true
        if (directory.startsWith('/var/lib/overleaf/data/compile')) {
          hostDirectory = directory.replace(
            /^\/var\/lib\/overleaf\/data\/compiles?/,
            hostCompilesDir
          )
        } else if (directory.startsWith('/local/compile/directory')) {
          hostDirectory = directory.replace(
            '/local/compile/directory',
            hostCompilesDir + '/directory'
          )
        }
      } else {
        if (directory.startsWith('/var/lib/overleaf/data/compiles')) {
          hostDirectory = directory.replace(
            '/var/lib/overleaf/data/compiles',
            hostCompilesDir
          )
        } else if (directory.startsWith('/local/compile/directory')) {
          hostDirectory = directory.replace(
            '/local/compile/directory',
            hostCompilesDir + '/directory'
          )
        }
      }

      if (!isReadOnly && directory) {
        try {
          fs.chmodSync(directory, 0o777)
          const entries = fs.readdirSync(directory)
          for (const entry of entries) {
            try {
              const p = Path.join(directory, entry)
              const stat = fs.statSync(p)
              if (stat.isDirectory()) {
                fs.chmodSync(p, 0o777)
              } else {
                fs.chmodSync(p, 0o666)
              }
            } catch (e) {}
          }
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

      const executeWithRetry = (isRetry = false) => {
        this._runAndWaitForContainer(options, volumes, timeout, (err, output) => {
          if (err && (err.statusCode === 500 || err.message?.includes('500'))) {
            if (!isRetry) {
              logger.warn(
                { err, containerName, projectId },
                'HTTP 500 from docker daemon, destroying container and retrying once'
              )
              return this.destroyContainer(containerName, null, false, () => {
                executeWithRetry(true)
              })
            }
          }
          callback(err, output)
        })
      }

      executeWithRetry(false)
    })
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
    if (Settings.clsi?.docker?.seccompProfile) {
      securityOpts.push(
        `seccomp=${JSON.stringify(Settings.clsi.docker.seccompProfile)}`
      )
    }

    const hostConfig = {
      Binds: binds,
      LogConfig: { Type: 'none', Config: {} },
      CapDrop: ['ALL'],
      SecurityOpt: securityOpts,
    }

    const envMap = {
      HOME: '/tmp',
      CLSI: '1',
      ...(Settings.clsi?.docker?.env || {}),
      ...(env || {}),
    }

    const envArray = Object.entries(envMap).map(
      ([key, val]) => `${key}=${val}`
    )

    const workingDir = cwd ? Path.posix.join('/compile', cwd) : '/compile'

    const options = {
      Image: image,
      Cmd: command,
      User: Settings.clsi?.docker?.user || 'tex',
      WorkingDir: workingDir,
      Env: envArray,
      HostConfig: hostConfig,
    }

    const groupConfig =
      Settings.clsi?.docker?.compileGroupConfig?.[compileGroup]
    if (groupConfig) {
      for (const [key, value] of Object.entries(groupConfig)) {
        if (key.startsWith('HostConfig.')) {
          const prop = key.slice('HostConfig.'.length)
          options.HostConfig[prop] = value
        } else {
          options[key] = value
        }
      }
    }

    return options
  },

  _fingerprintContainer(options) {
    const relevant = {
      Image: options.Image,
      User: options.User,
      CapDrop: options.HostConfig?.CapDrop,
      SecurityOpt: options.HostConfig?.SecurityOpt,
      Binds: options.HostConfig?.Binds,
    }
    return crypto
      .createHash('md5')
      .update(JSON.stringify(relevant))
      .digest('hex')
  },

  _runAndWaitForContainer(options, volumes, timeout, callback) {
    let capturedOutput = { stdout: '', stderr: '' }

    const attachStreamHandler = (err, stream) => {
      if (err) return
      if (stream) {
        if (typeof stream.on === 'function') {
          stream.on('data', chunk => {
            capturedOutput.stdout += chunk.toString()
          })
        } else {
          capturedOutput = stream
        }
      }
    }

    this.startContainer(
      options,
      volumes,
      attachStreamHandler,
      (err, containerId) => {
        if (err) return callback(err)

        this.waitForContainer(
          options.name || containerId,
          timeout,
          options,
          (waitErr, exitCode) => {
            if (waitErr) return callback(waitErr)
            capturedOutput.exitCode = exitCode
            callback(null, capturedOutput)
          }
        )
      }
    )
  },

  startContainer(options, volumes, attachStreamHandler, callback) {
    const docker = getDocker()
    const container = docker.getContainer(options.name)

    container.inspect((err, info) => {
      if (err && err.statusCode === 404) {
        // Container does not exist, create it
        docker.createContainer(options, (createErr, newContainer) => {
          if (createErr) return callback(createErr)
          this.attachToContainer(
            options.name,
            attachStreamHandler,
            attachErr => {
              if (attachErr) return callback(attachErr)
              newContainer.start(startErr => {
                if (startErr && startErr.statusCode !== 304) {
                  return callback(startErr)
                }
                callback(null, newContainer.id || options.name)
              })
            }
          )
        })
      } else if (!err || err.statusCode === 304) {
        // Container exists
        this.attachToContainer(options.name, attachStreamHandler, attachErr => {
          if (attachErr) return callback(attachErr)
          container.start(startErr => {
            if (startErr && startErr.statusCode !== 304) {
              return callback(startErr)
            }
            callback(null, container.id || options.name)
          })
        })
      } else {
        callback(err)
      }
    })
  },

  attachToContainer(containerId, attachStreamHandler, callback) {
    const docker = getDocker()
    const container = docker.getContainer(containerId)
    container.attach(
      { stream: true, stdout: true, stderr: true },
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
    const docker = getDocker()
    const container = docker.getContainer(containerId)
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      container.kill(() => {
        const error = new Error('container timed out')
        error.timedout = true
        callback(error)
      })
    }, timeout)

    container.wait((err, data) => {
      clearTimeout(timer)
      if (timedOut) return

      if (err) {
        if (err.statusCode === 404 && options?.HostConfig?.AutoRemove === true) {
          return callback(null, 0)
        }
        return callback(err)
      }

      callback(null, data?.StatusCode ?? 0)
    })
  },

  destroyOldContainers(callback) {
    const docker = getDocker()
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

        const match = name.match(/^(?:sandbox-compiler|project)-([a-f0-9]+)-/)
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
        this.destroyContainer(name, c.Id, false, destroyErr => {
          if (destroyErr && !firstErr) firstErr = destroyErr
          remaining--
          if (remaining === 0) {
            callback(firstErr)
          }
        })
      }
    })
  },

  destroyContainer(name, id, shouldForce, callback) {
    if (typeof shouldForce === 'function') {
      callback = shouldForce
      shouldForce = false
    }
    this._destroyContainer(name || id, Boolean(shouldForce), callback)
  },

  _destroyContainer(containerId, shouldForce, callback) {
    const docker = getDocker()
    const container = docker.getContainer(containerId)
    container.remove(
      { force: Boolean(shouldForce), v: true },
      (err, result) => {
        if (err && err.statusCode === 404) {
          return callback(null)
        }
        callback(err || null)
      }
    )
  },

  kill(containerId, callback) {
    const docker = getDocker()
    const container = docker.getContainer(containerId)
    container.kill(err => {
      if (
        err &&
        (err.statusCode === 500 || err.statusCode === 404) &&
        err.message?.includes('is not running')
      ) {
        return callback()
      }
      if (err) {
        return callback(err)
      }
      callback()
    })
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
