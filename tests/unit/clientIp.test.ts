// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import {
  parseClientIpConfig,
  requestWithResolvedClientIp,
  resolveClientIp,
  RESOLVED_CLIENT_IP_HEADER,
  withResolvedClientIp
} from '~~/server/utils/clientIp'

const FORGED = '6.6.6.6'
const SOCKET = '198.51.100.20'
const PROXY = '10.0.0.5'

function configOf(trustedProxies: unknown = '', clientIpHeader: unknown = '') {
  return parseClientIpConfig({ trustedProxies, clientIpHeader }).config
}

function request(socketAddress: string | undefined, headers: Record<string, string> = {}) {
  return { socketAddress, header: (name: string) => headers[name] }
}

describe('parsing the client IP settings', () => {
  it('reads nothing when both settings are unset', () => {
    const { config, invalid } = parseClientIpConfig({ trustedProxies: '', clientIpHeader: '' })

    expect(config.trustedProxies).toEqual([])
    expect(config.clientIpHeader).toBe('')
    expect(invalid).toEqual([])
  })

  it('splits a comma-separated list of addresses and CIDR ranges', () => {
    const { config, invalid } = parseClientIpConfig({
      trustedProxies: ' 10.0.0.0/8 , 127.0.0.1,::1, 2001:db8::/32 ',
      clientIpHeader: ''
    })

    expect(config.trustedProxies).toHaveLength(4)
    expect(invalid).toEqual([])
  })

  it('reports and drops malformed proxy entries', () => {
    const { config, invalid } = parseClientIpConfig({
      trustedProxies: '10.0.0.1,proxy.local,10.0.0.0/33,256.1.1.1,10.0.0.0/,1.2.3.4/8x,::1/129,,',
      clientIpHeader: ''
    })

    expect(config.trustedProxies).toHaveLength(1)
    expect(invalid).toEqual(['proxy.local', '10.0.0.0/33', '256.1.1.1', '10.0.0.0/', '1.2.3.4/8x', '::1/129'])
  })

  it('lower-cases and trims the client IP header name', () => {
    expect(configOf('', '  X-Real-IP ').clientIpHeader).toBe('x-real-ip')
  })

  it('treats a non-string value as unset', () => {
    // Nuxt passes NUXT_* overrides through destr, so `123` arrives as a number.
    const { config, invalid } = parseClientIpConfig({ trustedProxies: 123, clientIpHeader: ['x'] })

    expect(config.trustedProxies).toEqual([])
    expect(config.clientIpHeader).toBe('')
    expect(invalid).toEqual([])
  })

  it('treats missing keys as unset', () => {
    const { config } = parseClientIpConfig({})

    expect(config).toEqual({ trustedProxies: [], clientIpHeader: '' })
  })
})

describe('resolving the client IP with nothing configured', () => {
  const config = configOf()

  it('uses the socket address', () => {
    expect(resolveClientIp(request(SOCKET), config)).toBe(SOCKET)
  })

  it('ignores a forged X-Forwarded-For header', () => {
    expect(resolveClientIp(request(SOCKET, { 'x-forwarded-for': FORGED }), config)).toBe(SOCKET)
  })

  it('ignores a forged edge header', () => {
    expect(resolveClientIp(request(SOCKET, { 'x-real-ip': FORGED, 'cf-connecting-ip': FORGED }), config))
      .toBe(SOCKET)
  })

  it('maps an IPv4-mapped IPv6 socket address to IPv4', () => {
    expect(resolveClientIp(request('::ffff:127.0.0.1'), config)).toBe('127.0.0.1')
  })

  it('keeps an IPv6 socket address', () => {
    expect(resolveClientIp(request('2001:DB8::1'), config)).toBe('2001:db8::1')
  })

  it('answers undefined when the socket address is unknown', () => {
    expect(resolveClientIp(request(undefined, { 'x-forwarded-for': FORGED }), config)).toBeUndefined()
  })

  it('answers undefined for a socket address that is not an IP', () => {
    expect(resolveClientIp(request('unix:/run/app.sock'), config)).toBeUndefined()
  })

  it('reads an embedded IPv4 only in the last group of an IPv6 address', () => {
    expect(resolveClientIp(request('::1.2.3.4'), config)).toBe('::102:304')
    expect(resolveClientIp(request('::ffff:1.2.3.4'), config)).toBe('1.2.3.4')
    expect(resolveClientIp(request('64:ff9b::1.2.3.4'), config)).toBe('64:ff9b::102:304')
  })

  it('records one form per IPv6 address, whatever its spelling', () => {
    for (const spelling of ['2001:DB8:0:0:0:0:0:1', '2001:db8::1', '2001:0db8::0001', '2001:db8:0::0:1']) {
      expect(resolveClientIp(request(spelling), config), spelling).toBe('2001:db8::1')
    }
  })

  it('compresses the all-zero, loopback and trailing-zero addresses', () => {
    expect(resolveClientIp(request('0:0:0:0:0:0:0:0'), config)).toBe('::')
    expect(resolveClientIp(request('0:0:0:0:0:0:0:1'), config)).toBe('::1')
    expect(resolveClientIp(request('1:0:0:0:0:0:0:0'), config)).toBe('1::')
  })

  it('compresses the leftmost of two equal zero runs', () => {
    expect(resolveClientIp(request('2001:db8:0:0:1:0:0:1'), config)).toBe('2001:db8::1:0:0:1')
  })

  it('compresses the longest zero run, not the first one', () => {
    expect(resolveClientIp(request('1:0:0:2:0:0:0:3'), config)).toBe('1:0:0:2::3')
  })

  it('leaves a single zero group uncompressed', () => {
    expect(resolveClientIp(request('2001:db8::1:1:1:1:1'), config)).toBe('2001:db8:0:1:1:1:1:1')
  })

  it('writes a non-mapped embedded IPv4 in hex', () => {
    expect(resolveClientIp(request('64:ff9b::192.0.2.1'), config)).toBe('64:ff9b::c000:201')
  })

  it('rejects an IPv4 placed before a trailing ::', () => {
    expect(resolveClientIp(request('1.2.3.4::'), config)).toBeUndefined()
  })
})

describe('resolving the client IP behind a trusted proxy', () => {
  const config = configOf(`${PROXY},192.168.0.0/16`)

  it('takes the address the proxy appended', () => {
    expect(resolveClientIp(request(PROXY, { 'x-forwarded-for': '203.0.113.9' }), config)).toBe('203.0.113.9')
  })

  it('ignores X-Forwarded-For sent by a client that reached the app directly', () => {
    expect(resolveClientIp(request(SOCKET, { 'x-forwarded-for': FORGED }), config)).toBe(SOCKET)
  })

  it('skips a forged leftmost entry and keeps the one the proxy appended', () => {
    expect(resolveClientIp(request(PROXY, { 'x-forwarded-for': `${FORGED}, 203.0.113.9` }), config))
      .toBe('203.0.113.9')
  })

  it('skips every trusted hop from the right', () => {
    const xff = `${FORGED}, 203.0.113.9, 192.168.4.4, ${PROXY}`

    expect(resolveClientIp(request('192.168.1.1', { 'x-forwarded-for': xff }), config)).toBe('203.0.113.9')
  })

  it('returns the leftmost entry when every hop is trusted', () => {
    expect(resolveClientIp(request(PROXY, { 'x-forwarded-for': '192.168.7.7, 192.168.4.4' }), config))
      .toBe('192.168.7.7')
  })

  it('returns the proxy itself when it sent no X-Forwarded-For', () => {
    expect(resolveClientIp(request(PROXY), config)).toBe(PROXY)
  })

  it('stops at a malformed entry and keeps the trusted hop to its right', () => {
    for (const bad of ['unknown', '1.2.3.4:80', '[::1]', '', '999.1.1.1']) {
      const xff = `203.0.113.9, ${bad}, 192.168.4.4`

      expect(resolveClientIp(request(PROXY, { 'x-forwarded-for': xff }), config), bad).toBe('192.168.4.4')
    }
  })

  it('keeps the socket address when the last entry is malformed', () => {
    expect(resolveClientIp(request(PROXY, { 'x-forwarded-for': `${FORGED}, garbage` }), config)).toBe(PROXY)
  })

  it('matches an IPv4-mapped socket address against an IPv4 entry', () => {
    const local = configOf('127.0.0.1')

    expect(resolveClientIp(request('::ffff:127.0.0.1', { 'x-forwarded-for': FORGED }), local)).toBe(FORGED)
  })

  it('maps an IPv4-mapped forwarded entry to IPv4', () => {
    expect(resolveClientIp(request(PROXY, { 'x-forwarded-for': '::ffff:203.0.113.9' }), config))
      .toBe('203.0.113.9')
  })

  it('matches IPv6 proxies by CIDR range', () => {
    const v6 = configOf('2001:db8::/32')

    expect(resolveClientIp(request('2001:db8:aa::1', { 'x-forwarded-for': '2001:db9::7, 2001:db8::5' }), v6))
      .toBe('2001:db9::7')
  })

  it('does not match an IPv6 address against an IPv4 range', () => {
    const v4 = configOf('0.0.0.0/0')

    expect(resolveClientIp(request('2001:db8::1', { 'x-forwarded-for': FORGED }), v4)).toBe('2001:db8::1')
  })

  it('matches a CIDR range on a partial byte', () => {
    const narrow = configOf('10.0.0.0/30')

    expect(resolveClientIp(request('10.0.0.3', { 'x-forwarded-for': FORGED }), narrow)).toBe(FORGED)
    expect(resolveClientIp(request('10.0.0.4', { 'x-forwarded-for': FORGED }), narrow)).toBe('10.0.0.4')
  })

  it('behaves as unset when every proxy entry is malformed', () => {
    const broken = configOf('proxy.local,10.0.0.0/40')

    expect(resolveClientIp(request(PROXY, { 'x-forwarded-for': FORGED }), broken)).toBe(PROXY)
  })
})

describe('resolving the client IP from an edge header', () => {
  const config = configOf('', 'x-real-ip')

  it('takes the address the edge set', () => {
    expect(resolveClientIp(request(SOCKET, { 'x-real-ip': '203.0.113.9' }), config)).toBe('203.0.113.9')
  })

  it('ignores a forged X-Forwarded-For when the edge header is set', () => {
    const headers = { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': FORGED }

    expect(resolveClientIp(request(SOCKET, headers), config)).toBe('203.0.113.9')
  })

  it('ignores X-Forwarded-For when the edge header is missing', () => {
    expect(resolveClientIp(request(SOCKET, { 'x-forwarded-for': FORGED }), config)).toBe(SOCKET)
  })

  it('falls back to the socket address on a list or a malformed value', () => {
    for (const bad of [`${FORGED}, 203.0.113.9`, 'unknown', '', '1.2.3.4:80']) {
      expect(resolveClientIp(request(SOCKET, { 'x-real-ip': bad }), config), bad).toBe(SOCKET)
    }
  })

  it('falls back to the trusted proxy chain when the edge header is missing', () => {
    const both = configOf(PROXY, 'cf-connecting-ip')

    expect(resolveClientIp(request(PROXY, { 'x-forwarded-for': '203.0.113.9' }), both)).toBe('203.0.113.9')
  })

  it('trims and normalises the edge address', () => {
    expect(resolveClientIp(request(SOCKET, { 'x-real-ip': ' ::FFFF:203.0.113.9 ' }), config)).toBe('203.0.113.9')
  })
})

describe('resolving the client IP from an edge header behind trusted proxies', () => {
  const both = configOf(PROXY, 'x-real-ip')

  it('ignores the edge header when the socket is not a trusted proxy', () => {
    const headers = { 'x-real-ip': FORGED, 'x-forwarded-for': FORGED }

    expect(resolveClientIp(request(SOCKET, headers), both)).toBe(SOCKET)
  })

  it('takes the edge header when the socket is a trusted proxy', () => {
    const headers = { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': FORGED }

    expect(resolveClientIp(request(PROXY, headers), both)).toBe('203.0.113.9')
  })

  it('walks X-Forwarded-For from a trusted proxy when the edge header is malformed', () => {
    const headers = { 'x-real-ip': 'unknown', 'x-forwarded-for': '203.0.113.9' }

    expect(resolveClientIp(request(PROXY, headers), both)).toBe('203.0.113.9')
  })

  it('ignores the edge header when the socket address is unknown', () => {
    // In-process sub-requests have no socket address and forward the outer headers.
    expect(resolveClientIp(request(undefined, { 'x-real-ip': FORGED }), both)).toBeUndefined()
  })
})

describe('handing the resolved IP to better-auth', () => {
  it('replaces a client-sent value with the resolved IP', () => {
    const headers = new Headers({ [RESOLVED_CLIENT_IP_HEADER]: FORGED, 'user-agent': 'ua' })

    withResolvedClientIp(headers, SOCKET)

    expect(headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe(SOCKET)
    expect(headers.get('user-agent')).toBe('ua')
  })

  it('removes a client-sent value when no IP was resolved', () => {
    const headers = new Headers({ [RESOLVED_CLIENT_IP_HEADER]: FORGED })

    withResolvedClientIp(headers, undefined)

    expect(headers.has(RESOLVED_CLIENT_IP_HEADER)).toBe(false)
  })

  it('rebuilds the request with the header and keeps its body', async () => {
    const original = new Request('https://saas.example.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RESOLVED_CLIENT_IP_HEADER]: FORGED },
      body: JSON.stringify({ email: 'a@example.test' })
    })

    const rebuilt = requestWithResolvedClientIp(original, SOCKET)

    expect(rebuilt.method).toBe('POST')
    expect(rebuilt.url).toBe(original.url)
    expect(rebuilt.headers.get(RESOLVED_CLIENT_IP_HEADER)).toBe(SOCKET)
    await expect(rebuilt.json()).resolves.toEqual({ email: 'a@example.test' })
  })

  it('drops a client-sent header from the rebuilt request when no IP was resolved', () => {
    const original = new Request('https://saas.example.test/api/auth/get-session', {
      headers: { [RESOLVED_CLIENT_IP_HEADER]: FORGED }
    })

    expect(requestWithResolvedClientIp(original, undefined).headers.has(RESOLVED_CLIENT_IP_HEADER)).toBe(false)
  })
})
