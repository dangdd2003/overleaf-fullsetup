import fs from 'node:fs'

/**
 * Where a container reaches the Docker host. Found on its own: a container's
 * default route points at the host's bridge. DOCKER_HOST_GATEWAY overrides it
 * where that guess is wrong, e.g. with host networking.
 */

// Used only when the default route cannot be read (no /proc, or no route)
const FALLBACK_GATEWAY = '172.20.0.1'
const ROUTE_TABLE = '/proc/net/route'
const RTF_GATEWAY = 0x2

// /.dockerenv cannot appear or vanish while the process runs, so each answer
// is read once, not with a blocking stat on every client construction
let inDocker
let hostGateway

/** True when this process runs inside a Docker container. */
export function isRunningInDocker() {
  // A set gateway says localhost must be mapped, also on runtimes without
  // /.dockerenv (Podman)
  inDocker ??=
    Boolean(process.env.DOCKER_HOST_GATEWAY?.trim()) ||
    fs.existsSync('/.dockerenv')
  return inDocker
}

/** The IPv4 address of the Docker host, as seen from this container. */
export function dockerHostGateway() {
  hostGateway ??=
    process.env.DOCKER_HOST_GATEWAY?.trim() ||
    readDefaultGateway(ROUTE_TABLE) ||
    FALLBACK_GATEWAY
  return hostGateway
}

/**
 * The IPv4 default-route gateway in a route table such as /proc/net/route.
 * Its addresses are little-endian hex: 010014AC is 172.20.0.1.
 * Returns null when there is no such route or the table cannot be read.
 */
export function readDefaultGateway(path) {
  let table
  try {
    table = fs.readFileSync(path, 'utf8')
  } catch {
    return null
  }
  // Columns: Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
  for (const line of table.split('\n').slice(1)) {
    const [, destination, gatewayHex, flags, , , , mask] = line.trim().split(/\s+/)
    if (destination !== '00000000' || mask !== '00000000') continue
    if (!(parseInt(flags, 16) & RTF_GATEWAY)) continue
    const gateway = parseInt(gatewayHex, 16)
    if (!gateway) continue
    return [gateway & 0xff, (gateway >>> 8) & 0xff, (gateway >>> 16) & 0xff, gateway >>> 24]
      .join('.')
  }
  return null
}

/** Forgets the cached answers, so a test can give the next read its own. */
export function resetDockerHostCache() {
  inDocker = undefined
  hostGateway = undefined
}
