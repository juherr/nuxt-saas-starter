// SPDX-License-Identifier: MIT
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import ProfilePage from '~/pages/profile/index.vue'

// better-auth stores a user holding several global roles as one
// comma-separated value (`user,admin`): the profile badge must translate
// each role and join them, never show the stored value as is.

const { userState } = vi.hoisted(() => ({
  userState: { role: 'user' as string | null }
}))

// A small dictionary, so a test can tell a translated role from a raw value.
const messages: Record<string, string> = {
  'profile.roles.user': 'User',
  'profile.roles.admin': 'Administrator'
}
mockNuxtImport('useI18n', () => () => ({
  t: (key: string) => messages[key] ?? key,
  te: (key: string) => key in messages
}))
mockNuxtImport('useLocalePath', () => () => (path: string) => path)
mockNuxtImport('useAuth', () => () => ({
  user: ref({ id: 'user-1', name: 'Ada', email: 'ada@example.test', role: userState.role }),
  session: ref({ id: 'session-1' }),
  client: { listAccounts: vi.fn(async () => ({ data: [] })), linkSocial: vi.fn() }
}))

async function roleBadgeText() {
  const wrapper = await mountSuspended(ProfilePage)
  return wrapper.get('[data-testid="profile-role"]').text()
}

describe('profile role badge', () => {
  beforeEach(() => {
    userState.role = 'user'
  })

  it('translates a single role', async () => {
    expect(await roleBadgeText()).toBe('User')
  })

  it('translates each role of a list and joins them', async () => {
    userState.role = 'user,admin'
    expect(await roleBadgeText()).toBe('User, Administrator')
  })

  it('shows an unknown role of a list as its raw value', async () => {
    userState.role = 'user,auditor'
    expect(await roleBadgeText()).toBe('User, auditor')
  })

  it('shows an empty label for an empty role', async () => {
    userState.role = null
    expect(await roleBadgeText()).toBe('')
  })
})
