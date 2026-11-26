// SPDX-License-Identifier: MIT
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const updateUser = vi.hoisted(() => vi.fn(async () => ({ data: null })))
const toastAdd = vi.hoisted(() => vi.fn())

mockNuxtImport('useI18n', () => () => ({ t: translate }))
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))
mockNuxtImport('useAuth', () => () => ({
  user: ref({ id: 'user-1', name: 'Ada', email: 'ada@example.test', image: null }),
  useActiveOrganization: () => ref(null),
  client: { listAccounts: vi.fn(async () => ({ data: [] })), updateUser },
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

describe('profile avatar upload response', () => {
  beforeEach(() => {
    updateUser.mockClear()
    toastAdd.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function chooseAvatar(response: unknown) {
    registerEndpoint('/api/file/upload', { method: 'POST', handler: () => response, once: true })
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    const page = await mount()
    const input = page.find('input[type="file"]')
    const file = new File(['png'], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    await flushPromises()
    return { reload }
  }

  it('keeps the profile picture and says why when the stored file has no URL', async () => {
    const { reload } = await chooseAvatar({ success: true, file: { id: 'f1', url: null } })

    expect(updateUser).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: 'profile.toast.avatarNoUrl', color: 'error' }))
    expect(reload).not.toHaveBeenCalled()
  })

  it('sets the stored file URL as the profile picture', async () => {
    await chooseAvatar({ success: true, file: { id: 'f1', url: 'https://cdn.example.test/a.png' } })

    expect(updateUser).toHaveBeenCalledWith({ image: 'https://cdn.example.test/a.png' })
  })
})
