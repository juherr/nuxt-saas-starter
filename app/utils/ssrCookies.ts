// SPDX-License-Identifier: MIT
/**
 * Request-scoped cookie jar of the SSR render.
 *
 * In-process calls made while rendering (`setActive` through the auth client, then
 * `get-session`, `full-data`, ...) all start from the inbound `Cookie` header. When one of them
 * answers with a `Set-Cookie` (a new session token or cookie cache), the browser must receive it,
 * and the calls that follow in the same render must send the new value instead of the inbound
 * one. The jar is keyed on the request event, so it never outlives the request.
 *
 * Responses are captured by the auth client transport and by `ssrFetchHooks`, which the SSR
 * calls to the app's own API use (`fetchSession`'s `get-session`, the `$fetch` calls of the
 * dashboard layout and the onboarding page).
 *
 * Nothing here imports `h3` at run time: this file also ships in the client bundle, and the app
 * does not resolve `h3` itself.
 */

/** The part of the h3 event the jar uses; an `H3Event` satisfies it. */
export interface SsrCookieEvent {
  node: {
    req: { headers: { cookie?: string } }
    res: {
      getHeader: (name: string) => number | string | string[] | undefined
      setHeader: (name: string, value: string | string[]) => unknown
    }
  }
}

/** What the auth client transport needs from the jar: the cookie to send, and the capture. */
export interface SsrCookiePort {
  header: () => string | undefined
  capture: (response: Response) => void
}

/** Captured cookies by name; `null` marks a cookie the server deleted. */
type Jar = Map<string, string | null>

const jars = new WeakMap<SsrCookieEvent, Jar>()

function jarOf(event: SsrCookieEvent): Jar {
  let jar = jars.get(event)
  if (!jar) {
    jar = new Map()
    jars.set(event, jar)
  }
  return jar
}

/**
 * Splits a `Set-Cookie` value that may hold several cookies joined with ", ", without breaking
 * on the comma of an `Expires` date. Copied from h3 1.15 `splitCookiesString`, which Nitro
 * applies on the same path, because the app cannot import `h3` at run time.
 *
 * On the node-server path, Node 26 `Headers.getSetCookie()` already returns one entry per
 * cookie, so the split changes nothing there. It is a net for a value that arrives joined: a
 * runtime without `getSetCookie()`, or a handler that wrote `a=1, b=2` into a single header.
 */
export function splitSetCookieString(cookiesString: string): string[] {
  const cookiesStrings: string[] = []
  let pos = 0
  let start: number
  let ch: string
  let lastComma: number
  let nextStart: number
  let cookiesSeparatorFound: boolean
  const skipWhitespace = () => {
    while (pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos)))
      pos += 1
    return pos < cookiesString.length
  }
  const notSpecialChar = () => {
    ch = cookiesString.charAt(pos)
    return ch !== '=' && ch !== ';' && ch !== ','
  }
  while (pos < cookiesString.length) {
    start = pos
    cookiesSeparatorFound = false
    while (skipWhitespace()) {
      ch = cookiesString.charAt(pos)
      if (ch === ',') {
        lastComma = pos
        pos += 1
        skipWhitespace()
        nextStart = pos
        while (pos < cookiesString.length && notSpecialChar())
          pos += 1
        if (pos < cookiesString.length && cookiesString.charAt(pos) === '=') {
          cookiesSeparatorFound = true
          pos = nextStart
          cookiesStrings.push(cookiesString.slice(start, lastComma))
          start = pos
        } else {
          pos = lastComma + 1
        }
      } else {
        pos += 1
      }
    }
    if (!cookiesSeparatorFound || pos >= cookiesString.length)
      cookiesStrings.push(cookiesString.slice(start))
  }
  return cookiesStrings
}

function readSetCookies(response: Response): string[] {
  const headers = response.headers
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter((value): value is string => !!value)
  return values.flatMap(splitSetCookieString)
}

/** Name and value of a `Set-Cookie` line, the value being `null` when it deletes the cookie. */
function parseSetCookie(line: string): { name: string, value: string | null } | undefined {
  const [pair = '', ...attributes] = line.split(';')
  const separator = pair.indexOf('=')
  if (separator <= 0)
    return undefined
  const name = pair.slice(0, separator).trim()
  const value = pair.slice(separator + 1).trim()

  let maxAge: number | undefined
  let expires: number | undefined
  for (const attribute of attributes) {
    const [key = '', ...rest] = attribute.split('=')
    const attributeValue = rest.join('=').trim()
    switch (key.trim().toLowerCase()) {
      case 'max-age':
        // RFC 6265 ignores a Max-Age that is not an integer.
        if (/^-?\d+$/.test(attributeValue))
          maxAge = Number(attributeValue)
        break
      case 'expires':
        expires = Date.parse(attributeValue)
        break
    }
  }
  const deleted = maxAge !== undefined
    ? maxAge <= 0
    : expires !== undefined && !Number.isNaN(expires) && expires <= Date.now()
  return { name, value: deleted ? null : value }
}

function appendSetCookie(event: SsrCookieEvent, value: string) {
  // Same as h3 `appendResponseHeader`.
  const current = event.node.res.getHeader('set-cookie')
  if (!current) {
    event.node.res.setHeader('set-cookie', value)
    return
  }
  const values = Array.isArray(current) ? current : [current.toString()]
  event.node.res.setHeader('set-cookie', [...values, value])
}

/**
 * Hands every `Set-Cookie` of an in-process response to the browser response, one header per
 * cookie, and records it in the jar for the calls that follow in the same render.
 */
export function captureSetCookies(event: SsrCookieEvent, response: Response): void {
  const jar = jarOf(event)
  for (const line of readSetCookies(response)) {
    appendSetCookie(event, line)
    const cookie = parseSetCookie(line)
    if (cookie)
      jar.set(cookie.name, cookie.value)
  }
}

/**
 * The `Cookie` header for an in-process call. With nothing captured it is the inbound header as
 * is. Otherwise every inbound part is kept in place, except captured names: the first occurrence
 * takes the captured value (or goes, when deleted) and later duplicates are dropped; new names
 * are appended. Values are passed through raw.
 */
export function ssrCookieHeader(event: SsrCookieEvent): string | undefined {
  const inbound = event.node.req.headers.cookie
  const jar = jars.get(event)
  // Nothing captured: the inbound header goes out exactly as it came in.
  if (!jar?.size)
    return inbound || undefined

  const parts: string[] = []
  const written = new Set<string>()
  for (const raw of (inbound ?? '').split(';')) {
    const part = raw.trim()
    if (!part)
      continue
    const separator = part.indexOf('=')
    const name = separator > 0 ? part.slice(0, separator).trim() : undefined
    if (name === undefined || !jar.has(name)) {
      parts.push(part)
      continue
    }
    // A captured name takes the place of its first inbound occurrence only.
    if (written.has(name))
      continue
    written.add(name)
    const value = jar.get(name)
    if (value != null)
      parts.push(`${name}=${value}`)
  }
  for (const [name, value] of jar) {
    if (!written.has(name) && value !== null)
      parts.push(`${name}=${value}`)
  }
  return parts.length ? parts.join('; ') : undefined
}

/**
 * Puts the merged cookie on the headers of an outgoing SSR request, or removes the `cookie`
 * header when nothing is left. The `onRequest` hook of `ssrFetchHooks` calls it.
 */
export function applySsrCookie(event: SsrCookieEvent, headers: Headers): void {
  const cookie = ssrCookieHeader(event)
  if (cookie)
    headers.set('cookie', cookie)
  else
    headers.delete('cookie')
}

/** The `$fetch`/`useFetch` hooks of an SSR call to the app's own API; an ofetch context satisfies them. */
export interface SsrFetchHooks {
  onRequest?: (context: { options: { headers: Headers } }) => void
  onResponse?: (context: { response: Response }) => void
}

/**
 * Hooks for an SSR `$fetch` or `useFetch` to the app's own API: the request leaves with the jar's
 * cookie (read when it is sent), and the `Set-Cookie` of the response goes to the browser and into
 * the jar for the calls that follow. Without an event (in the browser) there is no hook: the
 * browser sends and stores its cookies itself.
 */
export function ssrFetchHooks(event: SsrCookieEvent | undefined): SsrFetchHooks {
  if (!event)
    return {}
  return {
    onRequest: ({ options }) => applySsrCookie(event, options.headers),
    onResponse: ({ response }) => captureSetCookies(event, response)
  }
}

/** The port the auth client transport uses during SSR; `undefined` without an event. */
export function ssrCookiePort(event: SsrCookieEvent | undefined): SsrCookiePort | undefined {
  if (!event)
    return undefined
  return {
    header: () => ssrCookieHeader(event),
    capture: response => captureSetCookies(event, response)
  }
}
