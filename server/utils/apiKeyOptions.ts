// SPDX-License-Identifier: MIT
import type { ApiKeyConfigurationOptions, ApiKeyOptions } from '@better-auth/api-key'

/**
 * Options of the API key plugin, shared by the app's auth instance and
 * the tests that wire the plugin with the organization access control.
 *
 * Keys belong to an organization: `api_key.reference_id` holds its id, and
 * creating a key requires `organizationId` and the `apiKey: ['create']`
 * permission in that organization (`ac` in shared/utils/permissions.ts).
 */
export const apiKeyPluginOptions = {
  references: 'organization',
  enableMetadata: true,
  schema: {
    apikey: {
      modelName: 'apiKey'
    }
  }
} satisfies ApiKeyConfigurationOptions & ApiKeyOptions
