import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1).optional(),
  SHOPIFY_SHOP_DOMAIN: z.string().min(1),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().default('2026-01'),
  KLAVIYO_PRIVATE_API_KEY: z.string().optional(),
  KLAVIYO_EMIT_ENABLED: bool,
  SHOPIFY_SYNC_ENABLED: bool,
  ADMIN_API_TOKEN: z.string().min(8),
  RULES_PATH: z.string().default('./config/rules.json'),
  PUBLIC_BASE_URL: z.string().url(),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
