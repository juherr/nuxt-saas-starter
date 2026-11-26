# app/

- Auth client: `useAuth()` (`composables/useAuth.ts`) — `client`, `session`, `user`, `loggedIn`,
  `organization`, `useActiveOrganization`, `subscription(s)`, `signIn`, `signUp`, `requestPasswordReset`,
  `resetPassword`, `signOut({ redirectTo })`.
- Route guards: `definePageMeta({ auth: { only: 'guest' | 'user', redirectUserTo, redirectGuestTo } })`
  or `auth: false` (`middleware/auth.global.ts`); route names starting with `admin` require the admin role.
  `organization.global.ts` switches the active org from the `:slug` param.
- i18n: SFCs with their own strings declare `<i18n src="./i18n.json"></i18n>` (other file names exist)
  and use `const { t } = useI18n()`;
  shared strings in `i18n/global.json`; links through `useLocalePath()`. Add every key to en, fr, ja
  and zh-CN (no `fallbackLocale`, missing keys render raw — #53).
- Forms: `z` and `zodOutput` are auto-imported from `utils/types.ts`; `schema = z.object(...)` with
  translated messages, `reactive<Partial<Schema>>`, `UForm`.
- API calls: plain `$fetch('/api/...')`; a call that runs during SSR spreads `useSsrFetchHooks()`
  into its options (not `useRequestHeaders(['cookie'])`): it sends cookies set earlier in the render
  (`setActive`) and forwards the response's `Set-Cookie` to the browser.
  Ignore the unused `$customFetch` plugin (`plugins/customFetch.ts`).
- Theme colors in `app.config.ts` (primary emerald, neutral slate).
- Nuxt UI v4 colours are `primary|secondary|success|info|warning|error|neutral` only: a v2 name
  (`gray`, `red`, `white`…) renders unstyled. `ui` props take class strings per slot
  (`th: 'py-2'`), not v2 objects.
