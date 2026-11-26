// SPDX-License-Identifier: MIT
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '../..')
const LOCALES = ['en', 'fr', 'ja', 'zh-CN'] as const

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flattenKeys(value: Json, prefix = ''): string[] {
  if (isObject(value) || Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenKeys(child, prefix ? `${prefix}.${key}` : key))
  }
  return [prefix]
}

function localeFiles(): string[] {
  return readdirSync(join(root, 'app'), { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.json'))
    .map(file => join(root, 'app', file))
    .filter((file) => {
      const content: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isObject(content) && 'en' in content
    })
    .sort()
}

function parityGaps(file: string): string[] {
  const content: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isObject(content))
    return [`${file}: not an object`]
  const name = relative(root, file)
  const unknownLocales = Object.keys(content)
    .filter(locale => !(LOCALES as readonly string[]).includes(locale))
    .map(locale => `${name} [${locale}] unknown locale block`)
  const enBlock = content.en
  const en = new Set(enBlock === undefined ? [] : flattenKeys(enBlock))
  const gaps = LOCALES.filter(locale => locale !== 'en').flatMap((locale) => {
    const block = content[locale]
    const keys = new Set(block === undefined ? [] : flattenKeys(block))
    return [
      ...[...en].filter(key => !keys.has(key)).map(key => `${name} [${locale}] missing ${key}`),
      ...[...keys].filter(key => !en.has(key)).map(key => `${name} [${locale}] extra ${key}`)
    ]
  })
  return [...unknownLocales, ...gaps]
}

describe('i18n locale key parity', () => {
  const files = localeFiles()

  it('finds the shared messages and the SFC message files', () => {
    expect(files).toContain(join(root, 'app/i18n/global.json'))
    expect(files).toContain(join(root, 'app/pages/index.json'))
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files.map(file => [relative(root, file), file]))('%s holds the same keys in every locale as in en', (_name, file) => {
    expect(parityGaps(file)).toEqual([])
  })
})
