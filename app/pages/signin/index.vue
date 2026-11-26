<!-- SPDX-License-Identifier: MIT -->
<i18n src="./i18n.json"></i18n>

<script setup lang="ts">
import { DEMO_ADMIN_CREDENTIALS, DEMO_USER_CREDENTIALS } from '~~/scripts/demo/seedData'

definePageMeta({
  auth: {
    only: 'guest'
  }
})

const { t } = useI18n()

useHead({
  title: t('signIn.signIn')
})
const auth = useAuth()
const toast = useToast()
const route = useRoute()
const localePath = useLocalePath()

const redirectTo = computed(() => {
  const redirect = route.query.redirect as string
  return localePath(redirect || '/')
})

const schema = z.object({
  email: z.email(t('signIn.errors.invalidEmail')),
  password: z.string().min(8, t('signIn.errors.passwordLength', { min: 8 })),
  rememberMe: z.boolean().optional()
})
type Schema = zodOutput<typeof schema>

const state = reactive<Partial<Schema>>({
  email: undefined,
  password: undefined,
  rememberMe: false
})

// The public demo publishes its two seeded accounts and creates no new one.
const demoMode = useRuntimeConfig().public.demoMode
const demoAccounts = [
  { id: 'user', label: 'signIn.demo.userAccount', credentials: DEMO_USER_CREDENTIALS },
  { id: 'admin', label: 'signIn.demo.adminAccount', credentials: DEMO_ADMIN_CREDENTIALS }
] as const

function fillDemoAccount(credentials: { email: string, password: string }) {
  state.email = credentials.email
  state.password = credentials.password
}

const loading = ref(false)
const loadingAction = ref('')
// Code of the 403 better-auth answers when `requireEmailVerification` is on
// and the email is not verified. The client exposes no runtime error-code map.
const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED'
const isEmailVerifyModalOpen = ref(false)
const resendLoading = ref(false)
let unverifiedEmail = ''
// Bumped each time the dialog opens, so a resend started for one account
// does not close or toast over a dialog reopened later for another one.
let emailVerifyDialogGeneration = 0

async function onSocialLogin(action: 'google' | 'github') {
  loading.value = true
  loadingAction.value = action
  // Without errorCallbackURL, OAuth callback failures land on better-auth's
  // own error page (api/routes/callback.mjs) instead of this one.
  auth.signIn.social({ provider: action, callbackURL: redirectTo.value, errorCallbackURL: localePath('/signin') })
}

onMounted(() => {
  const errorKey = socialSignInErrorKey(route.query.error)
  if (errorKey)
    toast.add({ title: t(errorKey), color: 'error' })
})

async function onSubmit(event: FormSubmitEvent<Schema>) {
  if (loading.value)
    return
  loading.value = true
  loadingAction.value = 'submit'
  const { error } = await auth.signIn.email({
    email: event.data.email,
    password: event.data.password,
    rememberMe: event.data.rememberMe,
    callbackURL: redirectTo.value
  })
  if (error) {
    if (error.code === EMAIL_NOT_VERIFIED) {
      unverifiedEmail = event.data.email
      emailVerifyDialogGeneration++
      isEmailVerifyModalOpen.value = true
      loading.value = false
      return
    }
    toast.add({
      title: error.message,
      color: 'error'
    })
  }
  loading.value = false
}

async function handleResendEmail() {
  if (resendLoading.value)
    return
  resendLoading.value = true
  const generation = emailVerifyDialogGeneration
  const { error } = await auth.sendVerificationEmail({
    email: unverifiedEmail,
    callbackURL: redirectTo.value
  })
  resendLoading.value = false
  if (generation !== emailVerifyDialogGeneration)
    return
  if (error) {
    toast.add({
      title: error.message,
      color: 'error'
    })
  } else {
    toast.add({
      title: t('signIn.resendEmailNeutral'),
      color: 'success'
    })
  }

  isEmailVerifyModalOpen.value = false
}
</script>

<template>
  <UContainer class="flex items-center justify-center sm:p-4 sm:min-w-160">
    <UCard class="w-full max-w-md">
      <template #header>
        <div class="text-center p-4">
          <h1 class="text-xl font-semibold">
            {{ t('signIn.welcome', { name: t('global.appName') }) }}
          </h1>
        </div>
      </template>
      <div class="space-y-4">
        <UAlert
          v-if="demoMode"
          data-testid="demo-banner"
          color="info"
          variant="subtle"
          icon="i-lucide-flask-conical"
          :title="t('signIn.demo.title')"
        >
          <template #description>
            <p class="mb-2">
              {{ t('signIn.demo.description') }}
            </p>
            <ul class="space-y-2">
              <li
                v-for="account in demoAccounts"
                :key="account.id"
                class="flex items-center justify-between gap-2"
              >
                <span class="min-w-0">
                  <span class="block font-medium">{{ t(account.label) }}</span>
                  <span class="block break-all font-mono text-xs">{{ account.credentials.email }}</span>
                  <span class="block break-all font-mono text-xs">{{ account.credentials.password }}</span>
                </span>
                <UButton
                  :data-testid="`demo-fill-${account.id}`"
                  size="xs"
                  color="info"
                  variant="outline"
                  :disabled="loading"
                  @click="fillDemoAccount(account.credentials)"
                >
                  {{ t('signIn.demo.fill') }}
                </UButton>
              </li>
            </ul>
          </template>
        </UAlert>

        <!-- OAuth is not configured on the demo, which refuses every new
             user: a social sign-in could only end on an error toast. -->
        <template v-if="!demoMode">
          <div
            data-testid="social-sign-in"
            class="grid grid-cols-1 sm:grid-cols-2 gap-2"
          >
            <UButton
              color="neutral"
              variant="outline"
              icon="i-simple-icons-google"
              class="justify-center"
              :loading="loading && loadingAction === 'google'"
              :disabled="loading"
              @click="onSocialLogin('google')"
            >
              Google
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-simple-icons-github"
              class="justify-center"
              :loading="loading && loadingAction === 'github'"
              :disabled="loading"
              @click="onSocialLogin('github')"
            >
              Github
            </UButton>
          </div>

          <USeparator :label="t('signIn.or')" />
        </template>

        <UForm
          :schema="schema"
          :state="state"
          class="space-y-4"
          @submit="onSubmit"
        >
          <UFormField
            :label="t('signIn.email')"
            name="email"
            required
          >
            <UInput
              v-model="state.email"
              type="email"
              class="w-full"
              :placeholder="t('signIn.emailPlaceholder')"
              autocomplete="email"
            />
          </UFormField>

          <UFormField
            :label="t('signIn.password')"
            name="password"
            required
          >
            <UInput
              v-model="state.password"
              type="password"
              class="w-full"
              :placeholder="t('signIn.passwordPlaceholder')"
            />
          </UFormField>

          <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <UFormField name="rememberMe">
              <UCheckbox
                v-model="state.rememberMe"
                :label="t('signIn.rememberMe')"
              />
            </UFormField>
            <UButton
              variant="link"
              color="neutral"
              :to="localePath('/forgot-password')"
            >
              {{ t('signIn.forgotPassword') }}
            </UButton>
          </div>

          <UButton
            type="submit"
            color="primary"
            block
            :disabled="loading"
            :loading="loading && loadingAction === 'submit'"
          >
            {{ t('signIn.signIn') }}
          </UButton>

          <div
            v-if="!demoMode"
            class="text-center text-sm"
          >
            {{ t('signIn.noAccount') }}
            <UButton
              variant="link"
              color="primary"
              :disabled="loading"
              :to="localePath({ path: '/signup', query: route.query })"
            >
              {{ t('signIn.createAccount') }}
            </UButton>
          </div>
        </UForm>
      </div>
    </UCard>

    <!-- With #content, Nuxt UI renders title/description visually hidden,
         as the dialog's accessible name and description. -->
    <UModal
      v-model:open="isEmailVerifyModalOpen"
      :title="t('signIn.emailNotVerified')"
      :description="t('signIn.emailNotVerifiedDesc')"
    >
      <template #content>
        <UCard>
          <template #header>
            <div class="flex items">
              <h3 class="text-lg font-medium">
                {{ t('signIn.emailNotVerified') }}
              </h3>
            </div>
          </template>

          <p class="text-sm">
            {{ t('signIn.emailNotVerifiedDesc') }}
          </p>

          <template #footer>
            <div class="flex justify-end gap-3">
              <UButton
                color="neutral"
                variant="outline"
                @click="isEmailVerifyModalOpen = false"
              >
                {{ t('global.page.cancel') }}
              </UButton>
              <UButton
                color="primary"
                :loading="resendLoading"
                @click="handleResendEmail"
              >
                {{ t('signIn.sendEmail') }}
              </UButton>
            </div>
          </template>
        </UCard>
      </template>
    </UModal>
  </UContainer>
</template>
