// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The run-level gate of .github/workflows/demo.yml is written twice: in the
// concurrency group expression and in the reset job's if:. Read as text, so
// no YAML parser is needed.
const workflow = readFileSync(join(__dirname, '../../.github/workflows/demo.yml'), 'utf8')
const lines = workflow.split('\n')

function concurrencyGate(): string {
  const match = /^ {2}group: \$\{\{ \((.+)\) && 'demo' \|\| format\('demo-skipped-\{0\}', github\.run_id\) \}\}$/m.exec(workflow)
  if (!match?.[1])
    throw new Error('no gated concurrency group in demo.yml')
  return match[1]
}

function resetGate(): string {
  const start = lines.indexOf('  reset:')
  if (start < 0)
    throw new Error('no reset job in demo.yml')
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line))
      break
    const match = /^ {4}if: (.+)$/.exec(line)
    if (match?.[1])
      return match[1]
  }
  throw new Error('no if: on the reset job of demo.yml')
}

// The clauses of the workflow_run branch: `github.event_name !=
// 'workflow_run' || (<a> && <b> && ...)`.
function workflowRunClauses(gate: string): string[] {
  const match = /^github\.event_name != 'workflow_run' \|\| \((.+)\)$/.exec(gate)
  if (!match?.[1])
    throw new Error(`gate does not let non-workflow_run events through: ${gate}`)
  return match[1].split(' && ').sort()
}

describe('demo.yml run gate', () => {
  it('is the same text in the concurrency group and the reset job', () => {
    expect(resetGate()).toBe(concurrencyGate())
  })

  it('runs a workflow_run only for a green push CI run of this repository at the tip of main', () => {
    const expected = [
      'github.event.workflow_run.conclusion == \'success\'',
      'github.event.workflow_run.event == \'push\'',
      'github.event.workflow_run.head_repository.full_name == github.repository',
      'github.event.workflow_run.head_sha == github.sha'
    ].sort()
    expect(workflowRunClauses(concurrencyGate())).toEqual(expected)
    expect(workflowRunClauses(resetGate())).toEqual(expected)
  })
})
