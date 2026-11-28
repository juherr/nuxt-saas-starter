// SPDX-License-Identifier: MIT

/**
 * Client IP resolution (#24). Forwarded headers are client input: they are
 * read only when the deployment says who sets them.
 *
 * - `clientIpHeader`: one header the edge always overwrites (e.g.
 *   `cf-connecting-ip`, `x-real-ip`). Taken as is when it holds one valid IP,
 *   and, when `trustedProxies` is set, only from a socket address it lists:
 *   a client reaching the port directly cannot choose its IP through it.
 * - `trustedProxies`: IPs or CIDR ranges of reverse proxies. The socket address
 *   is the rightmost hop; hops are walked right to left over
 *   `X-Forwarded-For` while they are trusted proxies, and the first other
 *   address is the client.
 * - Neither: the socket address. `X-Forwarded-For` is ignored.
 */

/** Header that carries the resolved IP to better-auth (`advanced.ipAddress`). */
export const RESOLVED_CLIENT_IP_HEADER = 'x-resolved-client-ip'

interface Network {
  bytes: Uint8Array
  prefix: number
}

export interface ClientIpConfig {
  trustedProxies: Network[]
  clientIpHeader: string
}

export interface ClientIpRequest {
  socketAddress: string | undefined
  header: (name: string) => string | undefined
}

const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i
const PREFIX = /^\d{1,3}$/

function ipv4Bytes(value: string): Uint8Array | null {
  const parts = value.split('.')
  if (parts.length !== 4 || !parts.every(part => IPV4_OCTET.test(part) && Number(part) <= 255)) {
    return null
  }
  return Uint8Array.from(parts.map(Number))
}

function ipv6Bytes(value: string): Uint8Array | null {
  const halves = value.split('::')
  if (halves.length > 2) {
    return null
  }
  const groupsOf = (half: string | undefined) => (half ? half.split(':') : [])
  const head = groupsOf(halves[0])
  const tail = groupsOf(halves[1])
  // Only the last group may hold an embedded IPv4: after `::`, that is `tail`.
  const last = halves.length === 2 ? tail : head
  const embedded = last.at(-1)?.includes('.') ? ipv4Bytes(last.pop() ?? '') : undefined
  if (embedded === null) {
    return null
  }
  const explicit = [...head, ...tail]
  if (!explicit.every(group => IPV6_GROUP.test(group))) {
    return null
  }
  const width = 8 - (embedded ? 2 : 0)
  const missing = width - explicit.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null
  }
  // Groups after `::` are right-aligned; the bytes in between stay zero.
  const bytes = new Uint8Array(16)
  const write = (group: string, index: number) => {
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = value >> 8
    bytes[index * 2 + 1] = value & 0xFF
  }
  head.forEach(write)
  tail.forEach((group, i) => write(group, head.length + missing + i))
  if (embedded) {
    bytes.set(embedded, 12)
  }
  return bytes
}

const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF]

/** Bytes of an IP, IPv4-mapped IPv6 reduced to IPv4; `null` if not an IP. */
function ipBytes(value: string): Uint8Array | null {
  if (!value.includes(':')) {
    return ipv4Bytes(value)
  }
  const bytes = ipv6Bytes(value)
  if (bytes && MAPPED_PREFIX.every((byte, i) => bytes[i] === byte)) {
    return bytes.slice(12)
  }
  return bytes
}

/** The canonical form recorded for an IP, or `undefined` if not an IP. */
function normalizeIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  const bytes = ipBytes(trimmed)
  if (!bytes) {
    return undefined
  }
  return bytes.length === 4 ? bytes.join('.') : trimmed.toLowerCase()
}

function parseNetwork(entry: string): Network | null {
  const [address = '', prefixPart, ...rest] = entry.split('/')
  const bytes = ipBytes(address)
  if (!bytes || rest.length > 0) {
    return null
  }
  const maxBits = bytes.length * 8
  if (prefixPart === undefined) {
    return { bytes, prefix: maxBits }
  }
  const prefix = Number(prefixPart)
  return PREFIX.test(prefixPart) && prefix <= maxBits ? { bytes, prefix } : null
}

function inNetwork(ip: Uint8Array, network: Network): boolean {
  if (ip.length !== network.bytes.length) {
    return false
  }
  for (let bit = 0; bit < network.prefix; bit += 8) {
    const mask = (0xFF << (8 - Math.min(8, network.prefix - bit))) & 0xFF
    const i = bit / 8
    if (((ip[i] ?? 0) & mask) !== ((network.bytes[i] ?? 0) & mask)) {
      return false
    }
  }
  return true
}

/**
 * Reads the two settings. A non-string value (Nuxt parses `NUXT_*` overrides
 * with destr) counts as unset; malformed proxy entries are dropped and listed
 * in `invalid`, so an all-invalid list behaves as unset.
 */
export function parseClientIpConfig(raw: { trustedProxies?: unknown, clientIpHeader?: unknown }) {
  const entries = typeof raw.trustedProxies === 'string'
    ? raw.trustedProxies.split(',').map(entry => entry.trim()).filter(Boolean)
    : []
  const trustedProxies: Network[] = []
  const invalid: string[] = []
  for (const entry of entries) {
    const network = parseNetwork(entry)
    if (network) {
      trustedProxies.push(network)
    } else {
      invalid.push(entry)
    }
  }
  const clientIpHeader = typeof raw.clientIpHeader === 'string' ? raw.clientIpHeader.trim().toLowerCase() : ''
  const config: ClientIpConfig = { trustedProxies, clientIpHeader }
  return { config, invalid }
}

/** The client IP of a request, or `undefined` when none can be trusted. */
export function resolveClientIp(request: ClientIpRequest, config: ClientIpConfig): string | undefined {
  const socket = normalizeIp(request.socketAddress)
  const isTrusted = (ip: string) => {
    const bytes = ipBytes(ip)
    return !!bytes && config.trustedProxies.some(network => inNetwork(bytes, network))
  }
  const proxied = config.trustedProxies.length === 0 || (!!socket && isTrusted(socket))
  if (config.clientIpHeader && proxied) {
    const fromEdge = normalizeIp(request.header(config.clientIpHeader))
    if (fromEdge) {
      return fromEdge
    }
  }
  if (!socket || config.trustedProxies.length === 0) {
    return socket
  }
  const forwarded = request.header('x-forwarded-for')?.split(',') ?? []
  let hop = socket
  while (isTrusted(hop)) {
    const next = forwarded.pop()
    if (next === undefined) {
      return hop
    }
    const ip = normalizeIp(next)
    if (!ip) {
      return hop
    }
    hop = ip
  }
  return hop
}

/** Sets the resolved IP on `headers`, dropping any value the client sent. */
export function withResolvedClientIp(headers: Headers, ip: string | undefined): Headers {
  headers.delete(RESOLVED_CLIENT_IP_HEADER)
  if (ip) {
    headers.set(RESOLVED_CLIENT_IP_HEADER, ip)
  }
  return headers
}

/** A copy of `request` that carries the resolved IP instead of any client value. */
export function requestWithResolvedClientIp(request: Request, ip: string | undefined): Request {
  return new Request(request, { headers: withResolvedClientIp(new Headers(request.headers), ip) })
}
