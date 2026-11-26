// SPDX-License-Identifier: MIT
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import messages from '~/pages/[slug]/profile.i18n.json'
import ProfilePage from '~/pages/[slug]/profile.vue'

// The public demo stores no file (the upload route answers 403), so the
// profile page offers no avatar upload there.

type Locale = keyof typeof messages

const i18nState = vi.hoisted(() => ({ locale: null as string | null }))

// Without a locale, t() returns the key; with one, it resolves the key
// against the page's own translations, so a hard-coded label fails.
function translate(key: string) {
  const locale = i18nState.locale
  if (!locale || !(locale in messages))
    return key
  let node: unknown = messages[locale as Locale]
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node))
      return key
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : key
}

mockNuxtImport('useI18n', () => () => ({ t: translate }))
mockNuxtImport('useAuth', () => () => ({
  user: ref({ id: 'user-1', name: 'Ada', email: 'ada@example.test', image: null }),
  useActiveOrganization: () => ref(null),
  client: { listAccounts: vi.fn(async () => ({ data: [] })) },
  fetchSession: vi.fn()
}))

async function mount() {
  return mountSuspended(ProfilePage, { global: { stubs: { SettingsSessionsSection: true } } })
}

describe('profile avatar upload', () => {
  afterEach(() => {
    useRuntimeConfig().public.demoMode = false
    i18nState.locale = null
  })

  it('offers an avatar upload outside the public demo', async () => {
    const page = await mount()

    expect(page.text()).toContain('profile.avatar.upload')
    expect(page.find('input[type="file"]').exists()).toBe(true)
  })

  it('offers no avatar upload in the public demo', async () => {
    useRuntimeConfig().public.demoMode = true

    const page = await mount()

    expect(page.text()).not.toContain('profile.avatar.upload')
    expect(page.find('input[type="file"]').exists()).toBe(false)
    expect(page.find('.group-hover\\:opacity-100').exists()).toBe(false)
  })

  it('renders its labels in the active locale', async () => {
    i18nState.locale = 'fr'

    const page = await mount()

    expect(page.text()).toContain(messages.fr.profile.avatar.upload)
    expect(page.text()).toContain(messages.fr.profile.title)
    expect(page.text()).not.toContain('Upload Photo')
  })
})
