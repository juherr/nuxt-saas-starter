// SPDX-License-Identifier: MIT
// https://nuxt.com/docs/api/configuration/nuxt-config
import type { NuxtPage } from 'nuxt/schema'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'
import { readGitVersionInfo, resolveAppVersion } from './scripts/appVersion'
import { generateRuntimeConfig } from './server/utils/runtimeConfig'

console.log(`Current NODE_ENV: ${process.env.NODE_ENV}`)

const effectiveNitroPreset = (process.env.NODE_ENV === 'development' && !process.env.NUXT_FORCE_CLOUDFLARE_DEV)
  ? 'node-server'
  : (process.env.NUXT_NITRO_PRESET || 'node-server')

// Tag of the built commit, else dev-<short sha>, shown in the footer
const appVersion = resolveAppVersion({
  override: process.env.NUXT_PUBLIC_APP_VERSION,
  ...readGitVersionInfo(fileURLToPath(new URL('.', import.meta.url)))
})

export default defineNuxtConfig({
  compatibilityDate: '2025-12-10',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  modules: [
    '@nuxt/ui',
    '@nuxt/eslint',
    '@nuxtjs/i18n',
    '@nuxtjs/seo',
    'nuxt-echarts',
    ...(process.env.NODE_ENV === 'test' ? ['@nuxt/test-utils/module'] : []),
    '@nuxthub/core'
  ],
  hub: {
    db: {
      dialect: 'postgresql',
      // Without a URL at build time NuxtHub falls back to PGlite, which is not
      // installed: keep postgres-js and only migrate when a URL is available
      driver: 'postgres-js',
      applyMigrationsDuringBuild: !!(process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || process.env.DATABASE_URL)
    },
    kv: true,
    blob: true
  },
  i18n: {
    vueI18n: '~/i18n/i18n.config.ts',
    // Overridable at runtime with NUXT_PUBLIC_I18N_BASE_URL
    baseUrl: process.env.NUXT_APP_URL || '',
    locales: [
      { code: 'en', language: 'en-US', name: 'English' },
      { code: 'zh-CN', language: 'zh-CN', name: '简体中文' },
      { code: 'ja', language: 'ja-JP', name: '日本語' },
      { code: 'fr', language: 'fr-FR', name: 'Français' }
    ],
    defaultLocale: 'en'
  },
  echarts: {
    renderer: ['svg'],
    charts: ['LineChart', 'BarChart'],
    components: ['TitleComponent', 'TooltipComponent', 'GridComponent', 'LegendComponent']
  },
  sitemap: {
    exclude: [
      '/admin/**',
      '/403',
      '/profile'
    ]
  },
  seo: {
    canonicalLowercase: false
  },
  robots: {
    disallow: [
      '/admin',
      '/profile'
    ]
  },
  eslint: {
    config: {
      standalone: false
    }
  },
  fonts: {
    provider: 'local'
  },
  ogImage: {
    enabled: false
  },
  // @nuxtjs/seo 6 bundles nuxt-ai-ready and nuxt-skew-protection; keep them
  // off until they are adopted on purpose
  // https://nuxtseo.com/docs/nuxt-seo/migration-guide/v5-to-v6
  aiReady: false,
  skewProtection: false,
  icon: {
    serverBundle: false,
    clientBundle: {
      scan: {
        globInclude: ['**\/*.{vue,jsx,tsx,md,mdc,mdx}', 'app/**/*.ts']
      }
    }
  },
  hooks: {
    // Runs after every migration (build with a database URL, `nuxt db
    // migrate`, `pnpm dev`): moves API keys to organization ownership and
    // adds their foreign key, once. The file name keeps it to PostgreSQL.
    'hub:db:queries:paths': function (queries: string[]) {
      queries.push(fileURLToPath(new URL('./server/db/queries/api-key-organization-owner.postgresql.sql', import.meta.url)))
    },
    'pages:extend': function (pages: NuxtPage[]) {
      const pagesToRemove: NuxtPage[] = []
      pages.forEach((page) => {
        if (page.path.includes('component') || page.path.includes('/api')) {
          pagesToRemove.push(page)
        }
      })

      pagesToRemove.forEach((page: NuxtPage) => {
        pages.splice(pages.indexOf(page), 1)
      })
      // Uncomment to show current Routes
      // console.log(`\nCurrent Routes:`)
      // console.log(pages)
      // console.log(`\n`)
    }
  },
  runtimeConfig: generateRuntimeConfig(effectiveNitroPreset, { appVersion }),
  app: {
    head: {
      viewport: 'width=device-width, initial-scale=1, maximum-scale=5.0, minimum-scale=1.0',
      link: [
        { rel: 'icon', type: 'image/png', href: '/favicons/favicon-96x96.png', sizes: '96x96' },
        { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' },
        { rel: 'shortcut icon', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/favicons/apple-touch-icon.png' },
        { rel: 'manifest', href: '/favicons/site.webmanifest' }
      ],
      meta: [
        { name: 'apple-mobile-web-app-title', content: process.env.NUXT_APP_NAME }
      ]
    }
  },
  nitro: {
    preset: effectiveNitroPreset,
    ...(effectiveNitroPreset === 'cloudflare-module'
      ? {
          cloudflare: {
            deployConfig: true,
            nodeCompat: true
          }
        }
      : {}),
    rollupConfig: {
      external: effectiveNitroPreset != 'node-server' ? ['pg-native'] : undefined
    },
    esbuild: {
      options: {
        jsx: 'automatic',
        jsxImportSource: 'react'
      }
    },
    // Local uploads go through a handler, not `publicAssets`: those only
    // serve the files present at build time and cannot set headers per type.
    handlers: process.env.NUXT_APP_STORAGE === 'local'
      ? [{
          route: `${process.env.NUXT_LOCAL_PUBLIC_PATH || '/uploads'}/**`,
          handler: resolve('./server/handlers/localUploads.ts')
        }]
      : undefined
  },
  sourcemap: {
    server: false,
    client: false
  },
  $production: {
    build: {
      transpile: ['zod']
    }
  }
})
