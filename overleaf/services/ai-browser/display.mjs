import { spawn } from 'node:child_process'
import fs from 'node:fs'

/**
 * Xvfb for headed Chrome. Patchright is least detectable headed, and a
 * container has no screen, so the server brings its own. A lock or socket
 * left by an earlier run of this container is removed first: this is the
 * only X server here.
 */
export async function startDisplay({
  display = ':99',
  spawnFn = spawn,
  exists = fs.existsSync,
  remove = file => fs.rmSync(file, { force: true }),
  waitMs = 10_000,
  pollMs = 50,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const number = display.replace(/^:/, '')
  const socket = `/tmp/.X11-unix/X${number}`
  remove(`/tmp/.X${number}-lock`)
  remove(socket)

  const child = spawnFn(
    'Xvfb',
    [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  let exited = null
  child.once('exit', code => {
    exited = code ?? 'signal'
  })
  child.once('error', err => {
    exited = err.message
  })

  const started = Date.now()
  while (!exists(socket)) {
    if (exited !== null) {
      throw new Error(`Xvfb exited before it was ready (${exited})`)
    }
    if (Date.now() - started > waitMs) {
      child.kill()
      throw new Error('Xvfb did not start within 10 s')
    }
    await sleep(pollMs)
  }

  return { display, child, stop: () => child.kill() }
}
