export interface DiscountSpec {
  code: string;
  title: string;
  discountType: 'fixed_amount' | 'percentage' | 'free_shipping';
  value: number;                 // dollars for fixed_amount, percent (10 = 10%) for percentage
  customerGid?: string | null;   // restrict to one customer when known
  minSubtotalCents?: number;
  combinesWith: { orderDiscounts: boolean; productDiscounts: boolean; shippingDiscounts: boolean };
  usageLimit?: number;
}

export interface ShopifyAdminApi {
  createDiscountCode(spec: DiscountSpec): Promise<{ discountNodeId: string }>;
  deactivateDiscount(discountNodeId: string): Promise<void>;
  addCustomerTags(customerGid: string, tags: string[]): Promise<void>;
  removeCustomerTags(customerGid: string, tags: string[]): Promise<void>;
  setCustomerMetafields(customerGid: string, fields: { namespace: string; key: string; type: string; value: string }[]): Promise<void>;
}

export const customerGid = (id: number | string) => `gid://shopify/Customer/${id}`;

export type ShopifyAuth = { kind: 'token'; accessToken: string } | { kind: 'client_credentials'; clientId: string; clientSecret: string };

/** Supplies a current Admin API token. Client-credentials tokens last 24h; we refresh 5 minutes early and on a 401. */
export class TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  constructor(private readonly shopDomain: string, private readonly auth: ShopifyAuth, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async get(): Promise<string> {
    if (this.auth.kind === 'token') return this.auth.accessToken;
    if (this.cached && this.cached.expiresAt - this.now() > 5 * 60_000) return this.cached.token;
    const res = await this.fetchImpl(`https://${this.shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.auth.clientId, client_secret: this.auth.clientSecret }),
    });
    if (!res.ok) throw new Error(`Shopify token request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number; scope?: string };
    this.cached = { token: json.access_token, expiresAt: this.now() + json.expires_in * 1000 };
    return json.access_token;
  }
  invalidate(): void { this.cached = null; }
}

export class ShopifyAdmin implements ShopifyAdminApi {
  private readonly endpoint: string;
  private readonly tokens: TokenProvider;
  constructor(shopDomain: string, auth: ShopifyAuth | string, apiVersion: string, private readonly fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
    this.tokens = new TokenProvider(shopDomain, typeof auth === 'string' ? { kind: 'token', accessToken: auth } : auth, fetchImpl, now);
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, retried = false): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await this.tokens.get() },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && !retried) { this.tokens.invalidate(); return this.graphql<T>(query, variables, true); }
    if (!res.ok) throw new Error(`Shopify Admin API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
    if (!json.data) throw new Error('Shopify GraphQL: empty data');
    return json.data;
  }

  async createDiscountCode(spec: DiscountSpec): Promise<{ discountNodeId: string }> {
    if (spec.discountType === 'free_shipping') throw new Error('free_shipping discounts are not implemented yet');
    const value = spec.discountType === 'fixed_amount'
      ? { discountAmount: { amount: spec.value.toFixed(2), appliesOnEachItem: false } }
      : { percentage: spec.value / 100 };
    const input: Record<string, unknown> = {
      title: spec.title, code: spec.code, startsAt: new Date().toISOString(),
      usageLimit: spec.usageLimit ?? 1, appliesOncePerCustomer: true,
      combinesWith: spec.combinesWith,
      customerSelection: spec.customerGid ? { customers: { add: [spec.customerGid] } } : { all: true },
      customerGets: { value, items: { all: true } },
    };
    if (spec.minSubtotalCents && spec.minSubtotalCents > 0) {
      input['minimumRequirement'] = { subtotal: { greaterThanOrEqualToSubtotal: (spec.minSubtotalCents / 100).toFixed(2) } };
    }
    type R = { discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: { field: string[] | null; message: string }[] } };
    const data = await this.graphql<R>(
      `mutation CreateRewardCode($input: DiscountCodeBasicInput!) {
         discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message } } }`,
      { input },
    );
    const r = data.discountCodeBasicCreate;
    if (r.userErrors.length) throw new Error(`discountCodeBasicCreate: ${r.userErrors.map((e) => e.message).join('; ')}`);
    if (!r.codeDiscountNode) throw new Error('discountCodeBasicCreate returned no node');
    return { discountNodeId: r.codeDiscountNode.id };
  }

  async deactivateDiscount(discountNodeId: string): Promise<void> {
    type R = { discountCodeDeactivate: { userErrors: { message: string }[] } };
    const data = await this.graphql<R>(`mutation Deactivate($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { message } } }`, { id: discountNodeId });
    if (data.discountCodeDeactivate.userErrors.length) throw new Error(data.discountCodeDeactivate.userErrors.map((e) => e.message).join('; '));
  }

  async addCustomerTags(customerGid: string, tags: string[]): Promise<void> {
    type R = { tagsAdd: { userErrors: { message: string }[] } };
    const d = await this.graphql<R>(`mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: customerGid, tags });
    if (d.tagsAdd.userErrors.length) throw new Error(d.tagsAdd.userErrors.map((e) => e.message).join('; '));
  }

  async removeCustomerTags(customerGid: string, tags: string[]): Promise<void> {
    type R = { tagsRemove: { userErrors: { message: string }[] } };
    const d = await this.graphql<R>(`mutation RemoveTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: customerGid, tags });
    if (d.tagsRemove.userErrors.length) throw new Error(d.tagsRemove.userErrors.map((e) => e.message).join('; '));
  }

  async setCustomerMetafields(customerGid: string, fields: { namespace: string; key: string; type: string; value: string }[]): Promise<void> {
    type R = { metafieldsSet: { userErrors: { message: string }[] } };
    const metafields = fields.map((f) => ({ ownerId: customerGid, ...f }));
    const d = await this.graphql<R>(`mutation SetMeta($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`, { metafields });
    if (d.metafieldsSet.userErrors.length) throw new Error(d.metafieldsSet.userErrors.map((e) => e.message).join('; '));
  }
}
