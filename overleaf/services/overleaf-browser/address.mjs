import dns from 'node:dns'
import net from 'node:net'

/**
 * Which addresses are the public internet. The gateway's egress proxy
 * enforces it on every connection the browser asks for; the browser's API
 * uses it to refuse a private target early. Shared by both images.
 *
 * Keep BLOCKED_ADDRESSES in step with
 * services/web/modules/ai-assist/app/src/web-fetch/transport.mjs.
 */

const BLOCKED_ADDRESSES = new net.BlockList()
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED_ADDRESSES.addSubnet(prefix, bits, 'ipv4')
}
for (const [prefix, bits] of [
  // Unspecified, loopback and the old IPv4-compatible form (::a.b.c.d), then
  // the IPv4-translated form (::ffff:0:a.b.c.d): both embed an IPv4 address
  ['::', 96],
  ['::ffff:0:0:0', 96],
  // Documentation (RFC 9637) and SRv6 segment IDs (RFC 9602)
  ['3fff::', 20],
  ['5f00::', 16],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  BLOCKED_ADDRESSES.addSubnet(prefix, bits, 'ipv6')
}

/** True only for a globally routable unicast IP address. */
export function isPublicAddress(address) {
  const raw = String(address ?? '').replace(/^\[|\]$/g, '')
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (mapped) return isPublicAddress(mapped[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(raw)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return isPublicAddress(
      `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
    )
  }
  try {
    const family = net.isIP(raw)
    if (family === 4) return !BLOCKED_ADDRESSES.check(raw, 'ipv4')
    if (family === 6) return !BLOCKED_ADDRESSES.check(raw, 'ipv6')
  } catch {
    // an address BlockList cannot parse is not public
  }
  return false
}

/** One address for `host`, provided every address it resolves to is public. */
export async function resolvePublic(
  host,
  { lookup = dns.promises.lookup, isPublic = isPublicAddress } = {}
) {
  const bare = String(host ?? '').replace(/^\[|\]$/g, '')
  const family = net.isIP(bare)
  const addresses = family
    ? [{ address: bare, family }]
    : await lookup(bare, { all: true })
  if (
    addresses.length === 0 ||
    addresses.some(entry => !isPublic(entry.address))
  ) {
    const error = new Error(`${host} is not a public address`)
    error.code = 'EADDRBLOCKED'
    throw error
  }
  return addresses[0]
}
