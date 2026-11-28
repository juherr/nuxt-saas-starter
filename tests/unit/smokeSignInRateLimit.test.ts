// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = join(__dirname, '../../.github/scripts/smoke-sign-in-rate-limit.sh')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smoke-rate-limit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Runs the script against a curl stand-in that answers 401 once, then 429
// with the given X-Retry-After header line, and a sleep stand-in that
// records how long the script waited.
function run(retryAfterLine: string) {
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'count=$(($(cat "$COUNTER" 2>/dev/null || echo 0) + 1))',
    'echo "$count" > "$COUNTER"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out=$2; shift ;;',
    '    -D) headers=$2; shift ;;',
    '  esac',
    '  shift',
    'done',
    'echo "{}" > "$out"',
    'if [ "$count" = 1 ]; then printf "HTTP/1.1 401\\r\\n\\r\\n" > "$headers"; printf 401',
    'else printf "HTTP/1.1 429\\r\\n%s\\r\\n\\r\\n" "$RETRY_AFTER_LINE" > "$headers"; printf 429; fi',
    ''
  ].join('\n'))
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\necho "$1" > "$SLEPT"\n')
  chmodSync(join(bin, 'curl'), 0o755)
  chmodSync(join(bin, 'sleep'), 0o755)
  const slept = join(dir, 'slept')
  const result = spawnSync('bash', [script, 'demo@example.com'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NUXT_APP_URL: 'http://localhost:3000',
      COUNTER: join(dir, 'count'),
      SLEPT: slept,
      RETRY_AFTER_LINE: retryAfterLine,
      PATH: `${bin}:${process.env.PATH}`
    }
  })
  return { result, slept: () => readFileSync(slept, 'utf8').trim() }
}

describe('smoke-sign-in-rate-limit.sh', () => {
  // HTTP header names are case-insensitive (RFC 9110, section 5.1).
  it.each(['X-Retry-After: 7', 'x-retry-after: 7', 'X-RETRY-AFTER: 7', 'x-ReTrY-aFtEr:7'])(
    'reads the retry delay from %s and waits it out plus one second',
    (line) => {
      const { result, slept } = run(line)
      expect(result.stdout).toContain('X-Retry-After: 7\n')
      expect(result.status).toBe(0)
      expect(slept()).toBe('8')
    }
  )

  it('fails when the 429 carries no X-Retry-After header', () => {
    const { result } = run('Retry-After: 7')
    expect(result.stdout).toContain('::error::the 429 carries no X-Retry-After header')
    expect(result.status).toBe(1)
  })
})
