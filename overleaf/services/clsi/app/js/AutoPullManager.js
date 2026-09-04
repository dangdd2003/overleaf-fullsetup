import Docker from 'dockerode'
import logger from '@overleaf/logger'

let dockerClient
const inFlightPulls = new Map()

function getDocker() {
  if (!dockerClient) {
    dockerClient = new Docker({ socketPath: '/var/run/docker.sock' })
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
    logger.info({ imageName }, '[AutoPull] Starting docker pull for image')
    docker.pull(imageName, (err, stream) => {
      if (err) {
        logger.error({ err, imageName }, '[AutoPull] Failed to initiate docker pull')
        inFlightPulls.delete(imageName)
        return reject(err)
      }

      let lastLog = Date.now()
      docker.modem.followProgress(
        stream,
        (finishErr, output) => {
          inFlightPulls.delete(imageName)
          if (finishErr) {
            logger.error({ finishErr, imageName }, '[AutoPull] Error during docker pull')
            return reject(finishErr)
          }
          logger.info({ imageName }, '[AutoPull] Successfully pulled image')
          resolve(output)
        },
        event => {
          if (Date.now() - lastLog > 10000) {
            lastLog = Date.now()
            if (event.status) {
              logger.info({ imageName, status: event.status, progress: event.progress }, '[AutoPull] Pulling progress')
            }
          }
        }
      )
    })
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

  const images = rawList
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  if (defaultImage && !images.includes(defaultImage)) {
    images.unshift(defaultImage)
  }

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
  pullImage,
  imageExists,
  checkAndPullImages,
}
