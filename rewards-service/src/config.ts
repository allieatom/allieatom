import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const Raw = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1).optional(),
  SHOPIFY_SHOP_DOMAIN: z.string().min(1),                 // e.g. better-rhodes.myshopify.com
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().min(1).optional(),// Path A: admin "Develop apps" custom app token (shpat_...)
  SHOPIFY_CLIENT_ID: z.string().min(1).optional(),         // Path B: Dev Dashboard app (client credentials grant)
  SHOPIFY_CLIENT_SECRET: z.string().min(1).optional(),
  SHOPIFY_API_SECRET: z.string().min(1).optional(),        // signs app-proxy requests and app-created webhooks (= client secret for Path B)
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1).optional(),    // store-level webhooks created in Settings > Notifications use their own signing secret
  SHOPIFY_API_VERSION: z.string().default('2026-01'),
  KLAVIYO_PRIVATE_API_KEY: z.string().optional(),
  KLAVIYO_EMIT_ENABLED: bool,
  SHOPIFY_SYNC_ENABLED: bool,
  ADMIN_API_TOKEN: z.string().min(8),
  RULES_PATH: z.string().default('./config/rules.json'),
  PUBLIC_BASE_URL: z.string().url(),
});

export type ShopifyAuth = { kind: 'token'; accessToken: string } | { kind: 'client_credentials'; clientId: string; clientSecret: string };

export type Config = z.infer<typeof Raw> & {
  shopify: { auth: ShopifyAuth; webhookSecret: string; proxySecret: string | null };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = Raw.parse(env);
  const auth: ShopifyAuth | null = raw.SHOPIFY_ADMIN_ACCESS_TOKEN
    ? { kind: 'token', accessToken: raw.SHOPIFY_ADMIN_ACCESS_TOKEN }
    : raw.SHOPIFY_CLIENT_ID && raw.SHOPIFY_CLIENT_SECRET
      ? { kind: 'client_credentials', clientId: raw.SHOPIFY_CLIENT_ID, clientSecret: raw.SHOPIFY_CLIENT_SECRET }
      : null;
  if (!auth) throw new Error('Set SHOPIFY_ADMIN_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  const proxySecret = raw.SHOPIFY_API_SECRET ?? raw.SHOPIFY_CLIENT_SECRET ?? null;
  const webhookSecret = raw.SHOPIFY_WEBHOOK_SECRET ?? proxySecret;
  if (!webhookSecret) throw new Error('Set SHOPIFY_WEBHOOK_SECRET (store-level webhooks) or SHOPIFY_API_SECRET / SHOPIFY_CLIENT_SECRET (app webhooks)');
  return { ...raw, shopify: { auth, webhookSecret, proxySecret } };
}
