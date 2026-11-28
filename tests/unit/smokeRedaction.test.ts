// SPDX-License-Identifier: MIT
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

describe('smoke_request', () => {
  it('redacts the headers file it was given with -D', () => {
    // A curl stand-in that writes the fixture to the -D file.
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const fixture = join(dir, 'fixture.txt')
    writeFileSync(fixture, headers)
    writeFileSync(join(bin, 'curl'), [
      '#!/usr/bin/env bash',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -D) cp "$FIXTURE" "$2"; shift ;;',
      '    -o) echo "{}" > "$2"; shift ;;',
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
      { ...process.env, FIXTURE: fixture, PATH: `${bin}:${process.env.PATH}` }
    )
    expect(result.status).toBe(0)
    expectRedacted(file)
  })
})
