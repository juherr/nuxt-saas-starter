// SPDX-License-Identifier: MIT
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import AdminUsersPage from '~/pages/admin/user/index.vue'

// better-auth stores a user holding several global roles as one
// comma-separated value (`user,admin`). The role menu must edit that list,
// never overwrite it with the single role clicked.

interface RoleMenuItem {
  label: string
  type: string
  checked: boolean
  onUpdateChecked: (checked: boolean) => Promise<void>
}

const { setRole, rowState } = vi.hoisted(() => ({
  setRole: vi.fn(),
  rowState: { original: { id: 'user-2', role: 'user,admin' } }
}))

// A small dictionary, so a test can tell a translated role from a raw key.
const messages: Record<string, string> = {
  'user.roles.user': 'User',
  'user.roles.admin': 'Administrator'
}
mockNuxtImport('useI18n', () => () => ({
  t: (key: string) => messages[key] ?? key,
  te: (key: string) => key in messages
}))
mockNuxtImport('useAdminTable', () => () => ({ refresh: vi.fn() }))
mockNuxtImport('useAuth', () => () => ({
  client: { admin: { setRole } },
  user: ref({ id: 'user-1' })
}))

// Renders only the role cell of one row: the table itself is not under test.
const AdminTableStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', slots['role-cell']?.({ row: rowState }))
  }
})
const LayoutStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', slots.default?.())
  }
})

// The role cell holds the only dropdown whose items are checkboxes.
async function mountRoleMenuComponent(role: string) {
  rowState.original = { id: 'user-2', role }
  const wrapper = await mountSuspended(AdminUsersPage, {
    global: {
      stubs: {
        AdminTable: AdminTableStub,
        NuxtLayout: LayoutStub,
        CreateUserModal: true,
        BanUserModal: true
      }
    }
  })
  const menu = wrapper.findAllComponents({ name: 'UDropdownMenu' })
    .find(m => (m.props('items') as { type?: string }[]).some(item => item.type === 'checkbox'))
  if (!menu)
    throw new Error('role menu not rendered')
  return menu
}

async function mountRoleMenu(role: string) {
  const menu = await mountRoleMenuComponent(role)
  const items = menu.props('items') as RoleMenuItem[]
  return (label: string) => {
    const found = items.find(i => i.label === label)
    if (!found)
      throw new Error(`no ${label} item`)
    return found
  }
}

describe('admin users page role menu', () => {
  beforeEach(() => {
    setRole.mockReset()
    setRole.mockResolvedValue({ data: { user: {} }, error: null })
  })

  it('removes only the unchecked role from the list', async () => {
    const item = await mountRoleMenu('user,admin')

    await item('Administrator').onUpdateChecked(false)

    expect(setRole).toHaveBeenCalledWith({ userId: 'user-2', role: ['user'] })
    expect(rowState.original.role).toBe('user')
  })

  it('adds a checked role to the list', async () => {
    const item = await mountRoleMenu('user')

    await item('Administrator').onUpdateChecked(true)

    expect(setRole).toHaveBeenCalledWith({ userId: 'user-2', role: ['user', 'admin'] })
    expect(rowState.original.role).toBe('user,admin')
  })

  it('refuses to uncheck the only role', async () => {
    const item = await mountRoleMenu('user')

    await item('User').onUpdateChecked(false)

    expect(setRole).not.toHaveBeenCalled()
  })
})

describe('admin users page role badge', () => {
  async function roleLabel(role: string) {
    const menu = await mountRoleMenuComponent(role)
    return menu.findComponent({ name: 'UButton' }).text()
  }

  it('translates each role of a list and joins them', async () => {
    expect(await roleLabel('user,admin')).toBe('User, Administrator')
  })

  it('shows an unknown role of a list as its raw value', async () => {
    expect(await roleLabel('user,superuser')).toBe('User, superuser')
  })

  it('shows an empty label for an empty role', async () => {
    expect(await roleLabel('')).toBe('')
  })
})
