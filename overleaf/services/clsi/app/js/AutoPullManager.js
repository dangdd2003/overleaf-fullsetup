import Docker from 'dockerode'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

let dockerClient
const inFlightPulls = new Map()
// TeX Live images are several GB; a pull that makes no progress for this long
// is considered stuck so later compiles are not chained onto it forever.
const PULL_STALL_TIMEOUT_MS = 10 * 60 * 1000

// Same mapping DockerRunner applies to the image a compile runs, so startup
// pulls fetch from the registry the compiles actually use.
export function resolveImageName(imageName) {
  const override = Settings.texliveImageNameOveride
  if (!override) return imageName
  const parts = imageName.split('/')
  return `${override}/${parts[parts.length - 1]}`
}

function getDocker() {
  if (!dockerClient) {
    dockerClient = new Docker(Settings.clsi?.docker?.clientConfig || {})
  }
  return dockerClient
}

/**
 * Single image pull helper with deduplication of concurrent pulls.
 */
export function pullImage(imageName) {
  if (inFlightPulls.has(imageName)) {
    return inFlightPulls.get(imageName)
  }

  const docker = getDocker()
  const pullPromise = new Promise((resolve, reject) => {
    let settled = false
    let stallTimer
    let pullStream
    const settle = (err, output) => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      if (err) reject(err)
      else resolve(output)
    }
    const armStallTimer = () => {
      if (settled) return
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        logger.error({ imageName }, '[AutoPull] Pull stalled, giving up')
        if (pullStream && typeof pullStream.destroy === 'function') {
          pullStream.destroy()
        }
        settle(new Error(`docker pull of ${imageName} stalled`))
      }, PULL_STALL_TIMEOUT_MS)
    }
    armStallTimer()

    logger.info({ imageName }, '[AutoPull] Starting docker pull for image')
    docker.pull(imageName, (err, stream) => {
      if (err) {
        logger.error({ err, imageName }, '[AutoPull] Failed to initiate docker pull')
        return settle(err)
      }
      pullStream = stream

      let lastLog = Date.now()
      docker.modem.followProgress(
        stream,
        (finishErr, output) => {
          if (finishErr) {
            logger.error({ finishErr, imageName }, '[AutoPull] Error during docker pull')
            return settle(finishErr)
          }
          logger.info({ imageName }, '[AutoPull] Successfully pulled image')
          settle(null, output)
        },
        event => {
          armStallTimer()
          if (Date.now() - lastLog > 10000) {
            lastLog = Date.now()
            if (event.status) {
              logger.info({ imageName, status: event.status, progress: event.progress }, '[AutoPull] Pulling progress')
            }
          }
        }
      )
    })
  }).finally(() => {
    inFlightPulls.delete(imageName)
  })

  inFlightPulls.set(imageName, pullPromise)
  return pullPromise
}

/**
 * Checks if an image exists locally on the Docker host.
 */
export async function imageExists(imageName) {
  const docker = getDocker()
  try {
    const img = docker.getImage(imageName)
    await img.inspect()
    return true
  } catch (err) {
    if (err.statusCode === 404) {
      return false
    }
    logger.warn({ err, imageName }, '[AutoPull] Error inspecting image, assuming not found')
    return false
  }
}

/**
 * Checks all configured TeX Live images and pulls missing ones sequentially in background.
 */
export async function checkAndPullImages() {
  const rawList = process.env.ALL_TEX_LIVE_DOCKER_IMAGES || ''
  const defaultImage = process.env.TEX_LIVE_DOCKER_IMAGE || ''

  // also the images compiles are validated against (ALLOWED_IMAGES), and
  // under the registry override compiles actually run
  const images = [
    ...new Set(
      [
        defaultImage,
        ...rawList.split(','),
        ...(Settings.clsi?.docker?.allowedImages || []),
      ]
        .map(s => s.trim())
        .filter(Boolean)
        .map(resolveImageName)
    ),
  ]

  if (images.length === 0) {
    logger.info('[AutoPull] No TeX Live images configured to pull.')
    return
  }

  logger.info({ count: images.length, images }, '[AutoPull] Background image pull worker initialized')

  for (const imageName of images) {
    try {
      logger.info({ imageName }, '[AutoPull] Pulling latest image from remote registry...')
      await pullImage(imageName)
    } catch (err) {
      const existsLocally = await imageExists(imageName)
      if (existsLocally) {
        logger.warn(
          { err: err.message, imageName },
          '[AutoPull] Pull failed (registry/network issue), falling back to existing local image'
        )
      } else {
        logger.error(
          { err: err.message, imageName },
          '[AutoPull] Failed to pull image from remote registry'
        )
      }
    }
  }

  logger.info('[AutoPull] Finished checking and pulling all configured TeX Live images.')
}

export default {
  resolveImageName,
  pullImage,
  imageExists,
  checkAndPullImages,
}
