// SPDX-License-Identifier: MIT
import type { VueWrapper } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import ApiKeysSection from '~/components/settings/ApiKeysSection.vue'

// @better-auth/api-key with `references: 'organization'` reads the owning
// organization from a top-level `organizationId` on /api-key/create and
// answers 400 without it: the section must send it there, not in metadata.

const { createApiKey, toastAdd } = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  toastAdd: vi.fn()
}))

mockNuxtImport('useToast', () => () => ({ add: toastAdd }))
mockNuxtImport('useAuth', () => () => ({
  client: { apiKey: { create: createApiKey } },
  useActiveOrganization: () => ref({ data: { id: 'org-1', name: 'Acme' } })
}))

registerEndpoint('/api/organization/api-keys', () => [])

let wrapper: VueWrapper | undefined

function dialogButton(label: string) {
  const button = [...document.body.querySelectorAll('[role="dialog"] button')]
    .find(b => b.textContent?.trim() === label)
  if (!button)
    throw new Error(`no dialog button ${label}`)
  return button as HTMLButtonElement
}

describe('settings API keys section', () => {
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    createApiKey.mockReset()
    toastAdd.mockReset()
  })

  it('creates a key with the active organization as a top-level organizationId', async () => {
    createApiKey.mockResolvedValue({ data: { key: 'sk_secret' }, error: null })
    wrapper = await mountSuspended(ApiKeysSection, { props: { canManage: true } })

    const open = wrapper.findAll('button').find(b => b.text().includes('Create New Key'))
    await open?.trigger('click')
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"] input')).not.toBeNull())
    const input = document.body.querySelector('[role="dialog"] input') as HTMLInputElement
    input.value = 'CI'
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(dialogButton('Create').disabled).toBe(false))
    dialogButton('Create').click()

    await vi.waitFor(() => expect(createApiKey).toHaveBeenCalledTimes(1))
    const body = createApiKey.mock.calls[0]?.[0]
    expect(body).toMatchObject({ name: 'CI', organizationId: 'org-1' })
    expect(body).not.toHaveProperty('metadata')
  })
})
