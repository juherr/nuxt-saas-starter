// SPDX-License-Identifier: MIT
import { beforeAll, describe, expect, it, vi } from 'vitest'

describe('vue-i18n config', () => {
  beforeAll(() => {
    vi.stubGlobal('defineI18nConfig', <T>(config: T) => config)
  })

  it('falls back to English for keys a locale is missing', async () => {
    const { default: configFactory } = await import('~~/app/i18n/i18n.config')
    expect(configFactory()).toMatchObject({ legacy: false, locale: 'en', fallbackLocale: 'en' })
  })
})
