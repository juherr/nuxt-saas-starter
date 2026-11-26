// SPDX-License-Identifier: MIT
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import MembersPage from '~/pages/[slug]/members.vue'

// better-auth stores a member holding several roles as one comma-separated
// value (`admin,member`). The role menu must show every role the member
// holds and edit that list, never overwrite it with the single role picked.

interface RoleMenuItem {
  label: string
  type: string
  checked: boolean
  disabled?: boolean
  onUpdateChecked: (checked: boolean) => void
}

const { updateMemberRole, memberState } = vi.hoisted(() => ({
  updateMemberRole: vi.fn(),
  memberState: { role: 'admin,member', viewerRole: 'owner' }
}))

mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
mockNuxtImport('useAuth', () => () => ({
  organization: { updateMemberRole },
  session: ref({ activeOrganizationId: 'org-1' }),
  user: ref({ id: 'user-1' }),
  fetchSession: async () => {},
  refreshActiveOrg: async () => {},
  useActiveOrganization: () => ref({
    data: {
      id: 'org-1',
      name: 'Acme',
      invitations: [],
      members: [
        { id: 'member-1', userId: 'user-1', role: memberState.viewerRole, user: { name: 'Olivia', email: 'olivia@example.com' } },
        { id: 'member-2', userId: 'user-2', role: memberState.role, user: { name: 'Adam', email: 'adam@example.com' } }
      ]
    }
  })
}))

async function mountRoleMenu() {
  const wrapper = await mountSuspended(MembersPage, {
    global: { stubs: { MembersInviteForm: true } }
  })
  const menu = wrapper.findAllComponents({ name: 'UDropdownMenu' })
    .find(m => (m.props('items') as { type?: string }[]).some(item => item.type === 'checkbox'))
  if (!menu)
    throw new Error('role menu not rendered')
  const items = menu.props('items') as RoleMenuItem[]
  const item = (label: string) => {
    const found = items.find(i => i.label === label)
    if (!found)
      throw new Error(`no ${label} item`)
    return found
  }
  return { menu, item }
}

describe('members page role menu', () => {
  beforeEach(() => {
    memberState.viewerRole = 'owner'
    updateMemberRole.mockReset()
    updateMemberRole.mockResolvedValue({ error: null })
  })

  it('checks every role of a member holding several roles', async () => {
    memberState.role = 'admin,member'
    const { menu, item } = await mountRoleMenu()

    expect(item('Admin').checked).toBe(true)
    expect(item('Member').checked).toBe(true)
    expect(menu.text()).toContain('Admin, Member')
  })

  it('removes only the unchecked role from the list', async () => {
    memberState.role = 'admin,member'
    const { item } = await mountRoleMenu()

    item('Member').onUpdateChecked(false)

    expect(updateMemberRole).toHaveBeenCalledWith({
      organizationId: 'org-1',
      memberId: 'member-2',
      role: ['admin']
    })
  })

  it('adds a checked role to the list', async () => {
    memberState.role = 'admin'
    const { item } = await mountRoleMenu()

    item('Member').onUpdateChecked(true)

    expect(updateMemberRole).toHaveBeenCalledWith({
      organizationId: 'org-1',
      memberId: 'member-2',
      role: ['admin', 'member']
    })
  })

  it('refuses to uncheck the last role', async () => {
    memberState.role = 'member'
    const { item } = await mountRoleMenu()

    expect(item('Member').disabled).toBe(true)
    item('Member').onUpdateChecked(false)

    expect(updateMemberRole).not.toHaveBeenCalled()
  })
})

describe('members page role badge', () => {
  async function badgeTexts() {
    const wrapper = await mountSuspended(MembersPage, {
      global: { stubs: { MembersInviteForm: true } }
    })
    return wrapper.findAllComponents({ name: 'UBadge' }).map(b => b.text())
  }

  beforeEach(() => {
    memberState.viewerRole = 'owner'
  })

  it('joins the role labels of a member seen by a read-only viewer', async () => {
    memberState.viewerRole = 'member'
    memberState.role = 'admin,member'

    expect(await badgeTexts()).toContain('Admin, Member')
  })

  it('joins the role labels of an owner row seen by a manager', async () => {
    memberState.role = 'owner,admin'

    expect(await badgeTexts()).toContain('Owner, Admin')
  })
})
