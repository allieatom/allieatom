import type { DiscountSpec, ShopifyAdminApi } from '../src/shopify/admin.js';

export class FakeShopifyAdmin implements ShopifyAdminApi {
  created: DiscountSpec[] = []; tags: { gid: string; add?: string[]; remove?: string[] }[] = []; metafields: unknown[] = []; failNext = false;
  async createDiscountCode(spec: DiscountSpec) {
    if (this.failNext) { this.failNext = false; throw new Error('simulated Shopify outage'); }
    this.created.push(spec); return { discountNodeId: `gid://shopify/DiscountCodeNode/${1000 + this.created.length}` };
  }
  async ping() { return { name: 'Better Rhodes (fake)', myshopifyDomain: 'betterrhodes.myshopify.com' }; }
  async deactivateDiscount(): Promise<void> {}
  async addCustomerTags(gid: string, add: string[]) { this.tags.push({ gid, add }); }
  async removeCustomerTags(gid: string, remove: string[]) { this.tags.push({ gid, remove }); }
  async setCustomerMetafields(gid: string, fields: unknown[]) { this.metafields.push({ gid, fields }); }
}

export const paidOrder = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 18937236553862, name: 'BR-89796', email: 'caroline@example.com', currency: 'USD', financial_status: 'paid',
  created_at: '2026-10-11T18:40:30Z', processed_at: '2026-10-11T18:40:30Z',
  subtotal_price: '106.91', current_subtotal_price: '106.91', total_price: '134.77', discount_codes: [],
  customer: { id: 31277051641990, email: 'caroline@example.com', first_name: 'Caroline', last_name: 'M', state: 'disabled', orders_count: 1 },
  line_items: [
    { id: 1, title: 'VIP Checkout (Package Protection)', quantity: 1, price: '4.97', gift_card: false, product_id: 11 },
    { id: 2, title: 'Hand on Heart Cabernet Sauvignon Non-Alcoholic Wine', quantity: 6, price: '16.99', gift_card: false, product_id: 22 },
  ],
  ...over,
});
