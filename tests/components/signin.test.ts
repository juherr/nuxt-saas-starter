// SPDX-License-Identifier: MIT
import type { VueWrapper } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { DEMO_ADMIN_CREDENTIALS, DEMO_USER_CREDENTIALS } from '~~/scripts/demo/seedData'
import SignIn from '~/pages/signin/index.vue'

// better-auth answers a sign-in with an unverified email with a 403 whose
// code is `EMAIL_NOT_VERIFIED` (api/routes/sign-in.mjs). The page must open
// the verify-email modal on that code, and toast any other error.

const { signInEmail, sendVerificationEmail, toastAdd } = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  sendVerificationEmail: vi.fn(),
  toastAdd: vi.fn()
}))

mockNuxtImport('useI18n', () => () => ({ t: (key: string) => key }))
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))
mockNuxtImport('useAuth', () => () => ({
  signIn: { email: signInEmail, social: vi.fn() },
  sendVerificationEmail
}))

const notVerified = {
  data: null,
  error: { code: 'EMAIL_NOT_VERIFIED', status: 403, message: 'Email not verified' }
}

let wrapper: VueWrapper | undefined

async function mount() {
  wrapper = await mountSuspended(SignIn)
  return wrapper
}

async function submit(page: VueWrapper, email = 'jane@example.com') {
  const calls = signInEmail.mock.calls.length
  await page.find('input[type="email"]').setValue(email)
  await page.find('input[type="password"]').setValue('password123')
  await page.find('form').trigger('submit')
  await vi.waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(calls + 1))
}

function dialog() {
  return document.body.querySelector('[role="dialog"]')
}

function dialogButton(label: string) {
  const button = [...document.body.querySelectorAll('[role="dialog"] button')]
    .find(b => b.textContent?.includes(label))
  if (!button)
    throw new Error(`no dialog button ${label}`)
  return button as HTMLButtonElement
}

describe('sign-in page', () => {
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    signInEmail.mockReset()
    sendVerificationEmail.mockReset()
    toastAdd.mockReset()
  })

  it('opens the verify-email modal when the email is not verified', async () => {
    signInEmail.mockResolvedValue(notVerified)

    await submit(await mount())

    await vi.waitFor(() => expect(document.body.textContent).toContain('signIn.emailNotVerifiedDesc'))
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it('gives the verify-email dialog an accessible name and description', async () => {
    signInEmail.mockResolvedValue(notVerified)

    await submit(await mount())

    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    const labelId = dialog()!.getAttribute('aria-labelledby')
    const descriptionId = dialog()!.getAttribute('aria-describedby')
    expect(document.getElementById(labelId!)?.textContent?.trim()).toBe('signIn.emailNotVerified')
    expect(document.getElementById(descriptionId!)?.textContent?.trim()).toBe('signIn.emailNotVerifiedDesc')
  })

  // The server answers the same way whether or not an email went out (no
  // account enumeration, delivery failures swallowed), so the copy must not
  // claim that one was sent.
  it('closes the dialog with a neutral message once its own resend request completes', async () => {
    signInEmail.mockResolvedValue(notVerified)
    sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null })

    await submit(await mount())
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    dialogButton('signIn.sendEmail').click()

    await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith({ title: 'signIn.resendEmailNeutral', color: 'success' }))
    expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'signIn.sendEmailSuccess' }))
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('toasts a resend request error', async () => {
    signInEmail.mockResolvedValue(notVerified)
    sendVerificationEmail.mockResolvedValue({ data: null, error: { status: 429, message: 'Too many requests' } })

    await submit(await mount())
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    dialogButton('signIn.sendEmail').click()

    await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith({ title: 'Too many requests', color: 'error' }))
  })

  it('ignores a resend that completes after the dialog was reopened for another account', async () => {
    signInEmail.mockResolvedValue(notVerified)
    let finishResend!: (value: unknown) => void
    sendVerificationEmail.mockReturnValue(new Promise((resolve) => {
      finishResend = resolve
    }))

    const page = await mount()
    await submit(page, 'alice@example.com')
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    dialogButton('signIn.sendEmail').click()
    await vi.waitFor(() => expect(sendVerificationEmail).toHaveBeenCalled())
    dialogButton('global.page.cancel').click()
    await vi.waitFor(() => expect(dialog()).toBeNull())

    await submit(page, 'bob@example.com')
    await vi.waitFor(() => expect(dialog()).not.toBeNull())

    finishResend({ data: { status: true }, error: null })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(dialog()).not.toBeNull()
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it('toasts any other sign-in error without opening the modal', async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401, message: 'Invalid email or password' }
    })

    await submit(await mount())

    await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith({ title: 'Invalid email or password', color: 'error' }))
    expect(document.body.textContent).not.toContain('signIn.emailNotVerifiedDesc')
  })

  describe('outside the public demo', () => {
    it('shows no demo banner and keeps the sign-up link', async () => {
      const page = await mount()

      expect(page.find('[data-testid="demo-banner"]').exists()).toBe(false)
      expect(page.text()).toContain('signIn.createAccount')
    })

    it('offers the social sign-in buttons and their divider', async () => {
      const page = await mount()

      expect(page.find('[data-testid="social-sign-in"]').exists()).toBe(true)
      expect(page.text()).toContain('Google')
      expect(page.text()).toContain('Github')
      expect(page.text()).toContain('signIn.or')
    })
  })

  describe('in the public demo', () => {
    beforeEach(() => {
      useRuntimeConfig().public.demoMode = true
    })
    afterEach(() => {
      useRuntimeConfig().public.demoMode = false
    })

    it('shows both demo accounts and hides the sign-up link', async () => {
      const page = await mount()

      const banner = page.find('[data-testid="demo-banner"]')
      expect(banner.exists()).toBe(true)
      for (const credentials of [DEMO_USER_CREDENTIALS, DEMO_ADMIN_CREDENTIALS]) {
        expect(banner.text()).toContain(credentials.email)
        expect(banner.text()).toContain(credentials.password)
      }
      expect(page.text()).not.toContain('signIn.createAccount')
      expect(page.text()).not.toContain('signIn.noAccount')
    })

    // OAuth is not configured on the demo, which refuses every new user:
    // a social sign-in could only end on an error toast.
    it('hides the social sign-in buttons and their divider', async () => {
      const page = await mount()

      expect(page.find('[data-testid="social-sign-in"]').exists()).toBe(false)
      expect(page.text()).not.toContain('Google')
      expect(page.text()).not.toContain('Github')
      expect(page.text()).not.toContain('signIn.or')
    })

    it.each([
      ['user', DEMO_USER_CREDENTIALS],
      ['admin', DEMO_ADMIN_CREDENTIALS]
    ])('fills the form with the demo %s account without submitting it', async (account, credentials) => {
      signInEmail.mockResolvedValue({ data: {}, error: null })
      const page = await mount()

      await page.find(`[data-testid="demo-fill-${account}"]`).trigger('click')
      await nextTick()
      expect(signInEmail).not.toHaveBeenCalled()

      await page.find('form').trigger('submit')
      await vi.waitFor(() => expect(signInEmail).toHaveBeenCalledWith(expect.objectContaining({
        email: credentials.email,
        password: credentials.password
      })))
    })
  })
})
