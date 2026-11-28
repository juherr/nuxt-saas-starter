// SPDX-License-Identifier: MIT
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The smoke scripts write response headers with `curl -D`, and CI uploads
// those files as artifacts of a public repository on failure: no cookie
// value may stay in them.
const smokeRequest = join(__dirname, '../../.github/scripts/smoke-request.sh')

const tokens = [
  'plainSessionToken123.SignaturePlain%2B%3D',
  'secureSessionToken456.SignatureSecure%2F%3D',
  'eyJzZXNzaW9uIjp7fX0.cachedSessionData'
]

// What curl -D writes: CRLF line ends, one Set-Cookie line per cookie.
const headers = [
  'HTTP/1.1 200 OK',
  'content-type: application/json',
  `set-cookie: better-auth.session_token=${tokens[0]}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`,
  `Set-Cookie: __Secure-better-auth.session_token=${tokens[1]}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`,
  `SET-COOKIE: better-auth.session_data=${tokens[2]}; Max-Age=300; Path=/`,
  'set-cookie: better-auth.dont_remember=; Max-Age=0; Path=/',
  'location: /dashboard',
  '',
  ''
].join('\r\n')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smoke-redaction-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function bash(script: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync('bash', ['-c', script, 'bash', ...args], { encoding: 'utf8', env })
  expect(result.stderr).toBe('')
  return result
}

function expectRedacted(file: string) {
  const redacted = readFileSync(file, 'utf8')
  for (const token of tokens)
    expect(redacted).not.toContain(token)
  // Cookie names and attributes stay, so the scripts' checks still work.
  expect(redacted).toMatch(/^set-cookie: better-auth\.session_token=\S+; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax\r$/m)
  expect(redacted).toMatch(/^Set-Cookie: __Secure-better-auth\.session_token=\S+; Max-Age=604800;/m)
  expect(redacted).toMatch(/^SET-COOKIE: better-auth\.session_data=\S+; Max-Age=300; Path=\/\r$/m)
  expect(redacted).toMatch(/^set-cookie: better-auth\.dont_remember=\S*; Max-Age=0; Path=\/\r$/m)
  // smoke-sign-in.sh's check of a session cookie in the response.
  expect(redacted).toMatch(/^set-cookie: (__Secure-)?better-auth\.session_token=/im)
  expect(redacted).toContain('location: /dashboard\r\n')
  expect(redacted).toContain('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n')
}

describe('smoke_redact_headers', () => {
  it('replaces every cookie value of a headers file and keeps the names', () => {
    const file = join(dir, 'sign-in-headers.txt')
    writeFileSync(file, headers)
    const result = bash('. "$1" && smoke_redact_headers "$2"', [smokeRequest, file])
    expect(result.status).toBe(0)
    expectRedacted(file)
  })

  it('succeeds on a missing headers file, as after a request that got no answer', () => {
    const result = bash('. "$1" && smoke_redact_headers "$2"', [smokeRequest, join(dir, 'none.txt')])
    expect(result.status).toBe(0)
  })
})

const bodyTokens = ['bodySessionToken789', 'nested\\"Token\\\\Escaped', 'spacedToken000', 'accessTokenValue111']

// A better-auth sign-in answer (compact), plus a nested, a spaced and an
// access token, a null one and a key that only starts with "token".
const body = `{"redirect":false,"token":"${bodyTokens[0]}","user":{"id":"u1","email":"a@example.com","session":{"token":"${bodyTokens[1]}"}},"other": { "token" : "${bodyTokens[2]}", "accessToken": "${bodyTokens[3]}" },"tokenCount":2,"verification":{"token":null}}\n`

const redactedBody = {
  redirect: false,
  token: '[redacted]',
  user: { id: 'u1', email: 'a@example.com', session: { token: '[redacted]' } },
  other: { token: '[redacted]', accessToken: '[redacted]' },
  tokenCount: 2,
  verification: { token: null }
}

function expectBodyRedacted(file: string) {
  const redacted = readFileSync(file, 'utf8')
  for (const token of bodyTokens)
    expect(redacted).not.toContain(token)
  expect(JSON.parse(redacted)).toEqual(redactedBody)
}

function redactBody(content: string): string {
  const file = join(dir, 'body.txt')
  writeFileSync(file, content)
  const result = bash('. "$1" && smoke_redact_body "$2"', [smokeRequest, file])
  expect(result.status).toBe(0)
  return readFileSync(file, 'utf8')
}

// A session token as better-auth signs it into the cookie: the token, a
// dot, then the URL-encoded signature.
const sessionToken = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'
const jar = [
  '# Netscape HTTP Cookie File',
  '',
  `#HttpOnly_localhost\tFALSE\t/\tFALSE\t0\tbetter-auth.session_token\t${sessionToken}.c2lnbmF0dXJl%2B%3D`,
  `localhost\tFALSE\t/\tFALSE\t0\tbetter-auth.session_data\teyJzZXNzaW9uIjp7fX0`,
  ''
].join('\n')

describe('smoke_redact_body', () => {
  it('replaces every JSON "token" string and keeps the rest of the body', () => {
    const file = join(dir, 'sign-in-body.txt')
    writeFileSync(file, body)
    const result = bash('. "$1" && smoke_redact_body "$2"', [smokeRequest, file])
    expect(result.status).toBe(0)
    expectBodyRedacted(file)
  })

  it('redacts a token whose key and value are on separate lines', () => {
    const redacted = redactBody(`{\n  "token":\n    "${bodyTokens[0]}",\n  "user": { "id": "u1" }\n}\n`)
    expect(redacted).not.toContain(bodyTokens[0])
    expect(JSON.parse(redacted)).toEqual({ token: '[redacted]', user: { id: 'u1' } })
  })

  // Fail closed: a body jq cannot parse may still hold a token.
  it.each([
    ['truncated JSON', `{"redirect":false,"token":"${bodyTokens[0]}","user":{"id":"u1"`],
    ['invalid JSON', `{"token": "${bodyTokens[0]}", oops}`],
    ['a page that is not JSON', `<html>error code: 1102 token=${bodyTokens[0]}</html>\n`]
  ])('replaces %s with a placeholder', (_, content) => {
    const redacted = redactBody(content)
    expect(redacted).not.toContain(bodyTokens[0])
    expect(redacted).toBe(`[body removed: not valid JSON, ${Buffer.byteLength(content)} bytes]\n`)
  })

  it('leaves an empty body empty', () => {
    expect(redactBody('')).toBe('')
  })

  it('succeeds on a missing body file', () => {
    const result = bash('. "$1" && smoke_redact_body "$2"', [smokeRequest, join(dir, 'none.txt')])
    expect(result.status).toBe(0)
  })
})

describe('smoke_redact_session_token', () => {
  // A server-rendered page: Nuxt serializes the get-session answer, whose
  // session carries the token, into its payload as a bare string.
  const page = `<html><body>Welcome back</body><script type="application/json" id="__NUXT_DATA__">[{"session":1},{"token":2,"userId":3},"${sessionToken}","u1"]</script><p>${sessionToken}</p></html>\n`

  function redactPage(content: string, jarContent = jar) {
    const file = join(dir, 'ssr-page-body.txt')
    const jarFile = join(dir, 'sign-in-cookies.txt')
    writeFileSync(file, content)
    writeFileSync(jarFile, jarContent)
    const result = bash('. "$1" && smoke_redact_session_token "$2" "$3"', [smokeRequest, file, jarFile])
    expect(result.status).toBe(0)
    return { output: result.stdout, redacted: readFileSync(file, 'utf8') }
  }

  it('replaces every occurrence of the jar\'s session token and keeps the page', () => {
    const { output, redacted } = redactPage(page)
    expect(redacted).not.toContain(sessionToken)
    expect(redacted).toBe(page.replaceAll(sessionToken, '[redacted]'))
    expect(output).toBe('ssr-page-body.txt: 2 occurrence(s) of the session token redacted\n')
  })

  it('removes the page when the jar\'s token holds characters it cannot match literally', () => {
    const odd = jar.replace(sessionToken, 'odd/token+value')
    const content = '<p>odd/token+value</p>\n'
    const { redacted } = redactPage(content, odd)
    expect(redacted).toBe(`[body removed: unexpected session token format, ${Buffer.byteLength(content)} bytes]\n`)
  })

  it('leaves the page alone when the jar holds no session token', () => {
    const { output, redacted } = redactPage(page, '# Netscape HTTP Cookie File\n')
    expect(redacted).toBe(page)
    expect(output).toBe('')
  })

  it('succeeds on a missing page file', () => {
    const jarFile = join(dir, 'sign-in-cookies.txt')
    writeFileSync(jarFile, jar)
    const result = bash('. "$1" && smoke_redact_session_token "$2" "$3"', [smokeRequest, join(dir, 'none.txt'), jarFile])
    expect(result.status).toBe(0)
  })
})

describe('smoke_request', () => {
  it('redacts the body file and the headers file it was given with -D', () => {
    // A curl stand-in that writes the fixture to the -D file.
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const fixture = join(dir, 'fixture.txt')
    writeFileSync(fixture, headers)
    const bodyFixture = join(dir, 'body-fixture.txt')
    writeFileSync(bodyFixture, body)
    writeFileSync(join(bin, 'curl'), [
      '#!/usr/bin/env bash',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -D) cp "$FIXTURE" "$2"; shift ;;',
      '    -o) cp "$BODY_FIXTURE" "$2"; shift ;;',
      '  esac',
      '  shift',
      'done',
      'printf 200',
      ''
    ].join('\n'))
    chmodSync(join(bin, 'curl'), 0o755)
    const file = join(dir, 'sign-in-headers.txt')
    const result = bash(
      '. "$1" && smoke_request sign-in 200 "$2" -D "$3" -X POST http://localhost/api/auth/sign-in/email',
      [smokeRequest, join(dir, 'body.txt'), file],
      { ...process.env, FIXTURE: fixture, BODY_FIXTURE: bodyFixture, PATH: `${bin}:${process.env.PATH}` }
    )
    expect(result.status).toBe(0)
    expectRedacted(file)
    expectBodyRedacted(join(dir, 'body.txt'))
  })

  // The redaction replaces a non-JSON body, so the retry has to read the
  // worker's "error code: 1102" before it.
  it('still retries on a Cloudflare 1102 body', () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'curl'), [
      '#!/usr/bin/env bash',
      'count=$(($(cat "$COUNTER" 2>/dev/null || echo 0) + 1))',
      'echo "$count" > "$COUNTER"',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out=$2; shift ;;',
      '  esac',
      '  shift',
      'done',
      'if [ "$count" = 1 ]; then echo "error code: 1102" > "$out"; printf 500; else echo "{}" > "$out"; printf 200; fi',
      ''
    ].join('\n'))
    chmodSync(join(bin, 'curl'), 0o755)
    const result = bash(
      '. "$1" && smoke_request sign-in 200 "$2" http://localhost/api/auth/sign-in/email',
      [smokeRequest, join(dir, 'body.txt')],
      { ...process.env, COUNTER: join(dir, 'count'), SMOKE_RETRY_ATTEMPTS: '2', SMOKE_RETRY_DELAY: '0', PATH: `${bin}:${process.env.PATH}` }
    )
    expect(result.stdout).toBe('sign-in: attempt 1/2 answered 500\nsign-in: attempt 2/2 answered 200\n')
    expect(result.status).toBe(0)
  })
})
