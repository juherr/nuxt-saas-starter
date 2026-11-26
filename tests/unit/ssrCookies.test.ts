// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { applySsrCookie, captureSetCookies, ssrCookieHeader, ssrCookieHeaders, ssrCookiePort, ssrFetchHooks } from '~~/app/utils/ssrCookies'
import { fakeEvent, responseWith } from './support/ssrCookieEvent'

const FUTURE = 'Wed, 21 Oct 2037 07:28:00 GMT'
const PAST = 'Thu, 01 Jan 1970 00:00:00 GMT'

describe('ssrCookies', () => {
  describe('applySsrCookie', () => {
    it('sets the merged cookie on the outgoing headers', () => {
      const { event } = fakeEvent('theme=dark; better-auth.session_data=org-1')
      captureSetCookies(event, responseWith('better-auth.session_data=org-2; Path=/'))
      const headers = new Headers({ cookie: 'theme=dark; better-auth.session_data=org-1' })

      applySsrCookie(event, headers)

      expect(headers.get('cookie')).toBe('theme=dark; better-auth.session_data=org-2')
    })

    it('removes the cookie header when every cookie was deleted', () => {
      const { event } = fakeEvent('a=1')
      captureSetCookies(event, responseWith('a=; Max-Age=0'))
      const headers = new Headers({ cookie: 'a=1' })

      applySsrCookie(event, headers)

      expect(headers.has('cookie')).toBe(false)
    })
  })

  describe('captureSetCookies', () => {
    it('forwards a Set-Cookie line without "=" to the browser but keeps it out of the jar', () => {
      const { event, setCookies } = fakeEvent('a=1')

      captureSetCookies(event, responseWith('malformed; Path=/'))

      expect(setCookies()).toEqual(['malformed; Path=/'])
      expect(ssrCookieHeader(event)).toBe('a=1')
    })

    it('splits two cookies joined in one header despite the comma of an Expires date', () => {
      const { event, setCookies } = fakeEvent()

      captureSetCookies(event, responseWith(`a=1; Expires=${FUTURE}; Path=/, b=2; Path=/; HttpOnly`))

      expect(setCookies()).toEqual([`a=1; Expires=${FUTURE}; Path=/`, 'b=2; Path=/; HttpOnly'])
      expect(ssrCookieHeader(event)).toBe('a=1; b=2')
    })

    it('appends one Set-Cookie per cookie to the event response, after the ones already there', () => {
      const { event, setCookies } = fakeEvent()
      event.node.res.setHeader('set-cookie', 'existing=1; Path=/')

      captureSetCookies(event, responseWith('a=1; Path=/', 'b=2; Path=/'))

      expect(setCookies()).toEqual(['existing=1; Path=/', 'a=1; Path=/', 'b=2; Path=/'])
    })

    it('leaves the event response untouched when the response sets no cookie', () => {
      const { event, setCookies } = fakeEvent('a=1')

      captureSetCookies(event, new Response(null))

      expect(setCookies()).toEqual([])
      expect(ssrCookieHeader(event)).toBe('a=1')
    })
  })

  describe('ssrCookieHeader', () => {
    it('returns the inbound cookie when nothing was captured', () => {
      const { event } = fakeEvent('a=1; b=2')

      expect(ssrCookieHeader(event)).toBe('a=1; b=2')
    })

    it('returns the inbound cookie byte for byte when nothing was captured', () => {
      const { event } = fakeEvent('a=1;b=2; a=3; flag')

      expect(ssrCookieHeader(event)).toBe('a=1;b=2; a=3; flag')
    })

    it('replaces a captured name in place and drops its later duplicates', () => {
      const { event } = fakeEvent('a=1;b=2; a=3; flag')

      captureSetCookies(event, responseWith('a=9'))

      expect(ssrCookieHeader(event)).toBe('a=9; b=2; flag')
    })

    it('keeps the other inbound parts, duplicates included, when another name is captured', () => {
      const { event } = fakeEvent('a=1;b=2; a=3')

      captureSetCookies(event, responseWith('b=9'))

      expect(ssrCookieHeader(event)).toBe('a=1; b=9; a=3')
    })

    it('ignores an empty Max-Age instead of treating it as a deletion', () => {
      const { event } = fakeEvent()

      captureSetCookies(event, responseWith('a=1; Max-Age='))

      expect(ssrCookieHeader(event)).toBe('a=1')
    })

    it('returns undefined when there is neither an inbound nor a captured cookie', () => {
      const { event } = fakeEvent()

      expect(ssrCookieHeader(event)).toBeUndefined()
    })

    it('overrides an inbound cookie and keeps the unrelated ones in their order', () => {
      const { event } = fakeEvent('theme=dark; better-auth.session_token=old; lang=fr')

      captureSetCookies(event, responseWith('better-auth.session_token=new; Path=/; HttpOnly'))

      expect(ssrCookieHeader(event)).toBe('theme=dark; better-auth.session_token=new; lang=fr')
    })

    it('treats __Secure- prefixed names as cookies of their own', () => {
      const { event } = fakeEvent('__Secure-better-auth.session_data=old; better-auth.session_data=plain')

      captureSetCookies(event, responseWith('__Secure-better-auth.session_data=new; Path=/; Secure'))

      expect(ssrCookieHeader(event)).toBe('__Secure-better-auth.session_data=new; better-auth.session_data=plain')
    })

    it('keeps the value raw, including an = sign', () => {
      const { event } = fakeEvent()

      captureSetCookies(event, responseWith('token=abc%2Fdef==.sig; Path=/'))

      expect(ssrCookieHeader(event)).toBe('token=abc%2Fdef==.sig')
    })

    it('drops a cookie deleted with Max-Age=0', () => {
      const { event } = fakeEvent('a=1; session_data=old')

      captureSetCookies(event, responseWith('session_data=; Max-Age=0; Path=/'))

      expect(ssrCookieHeader(event)).toBe('a=1')
    })

    it('drops a cookie deleted with an Expires date in the past', () => {
      const { event } = fakeEvent('a=1; session_data=old')

      captureSetCookies(event, responseWith(`session_data=; Expires=${PAST}; Path=/`))

      expect(ssrCookieHeader(event)).toBe('a=1')
    })

    it('keeps a cookie whose Max-Age is positive even when its Expires is past', () => {
      const { event } = fakeEvent()

      captureSetCookies(event, responseWith(`a=1; Max-Age=60; Expires=${PAST}`))

      expect(ssrCookieHeader(event)).toBe('a=1')
    })

    it('returns undefined when every cookie was deleted', () => {
      const { event } = fakeEvent('session_data=old')

      captureSetCookies(event, responseWith('session_data=; Max-Age=0'))

      expect(ssrCookieHeader(event)).toBeUndefined()
    })

    it('keeps one jar per event', () => {
      const first = fakeEvent('a=1')
      const second = fakeEvent('a=1')

      captureSetCookies(first.event, responseWith('a=2'))

      expect(ssrCookieHeader(first.event)).toBe('a=2')
      expect(ssrCookieHeader(second.event)).toBe('a=1')
    })
  })

  describe('ssrCookieHeaders', () => {
    it('returns no header without an event, like useRequestHeaders in the browser', () => {
      expect(ssrCookieHeaders(undefined)).toEqual({})
    })

    it('returns no header when the merged cookie is empty', () => {
      expect(ssrCookieHeaders(fakeEvent().event)).toEqual({})
    })

    it('returns the merged cookie under a lowercase key', () => {
      const { event } = fakeEvent('a=1')
      captureSetCookies(event, responseWith('b=2'))

      expect(ssrCookieHeaders(event)).toEqual({ cookie: 'a=1; b=2' })
    })
  })

  describe('ssrCookiePort', () => {
    it('is undefined without an event', () => {
      expect(ssrCookiePort(undefined)).toBeUndefined()
    })

    it('reads the jar at call time and captures into it', () => {
      const { event, setCookies } = fakeEvent('a=1')
      const port = ssrCookiePort(event)!

      expect(port.header()).toBe('a=1')
      port.capture(responseWith('a=2'))
      expect(port.header()).toBe('a=2')
      expect(setCookies()).toEqual(['a=2'])
    })
  })

  describe('ssrFetchHooks', () => {
    it('gives no hook without an event, so browser calls are left alone', () => {
      expect(ssrFetchHooks(undefined)).toEqual({})
    })

    it('forwards the Set-Cookie of the response to the browser response', () => {
      const { event, setCookies } = fakeEvent('better-auth.session_token=t')
      const { onResponse } = ssrFetchHooks(event)

      onResponse?.({ response: responseWith('better-auth.session_data=fresh; Path=/; HttpOnly') })

      expect(setCookies()).toEqual(['better-auth.session_data=fresh; Path=/; HttpOnly'])
    })

    it('sends the cookie captured by an earlier call of the same render', () => {
      const { event } = fakeEvent('better-auth.session_token=t; better-auth.session_data=stale')
      ssrFetchHooks(event).onResponse?.({ response: responseWith('better-auth.session_data=fresh; Path=/') })
      const headers = new Headers()

      ssrFetchHooks(event).onRequest?.({ options: { headers } })

      expect(headers.get('cookie')).toBe('better-auth.session_token=t; better-auth.session_data=fresh')
    })

    it('sends the inbound cookie when nothing was captured', () => {
      const { event } = fakeEvent('a=1')
      const headers = new Headers()

      ssrFetchHooks(event).onRequest?.({ options: { headers } })

      expect(headers.get('cookie')).toBe('a=1')
    })
  })
})
