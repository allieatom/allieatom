import type { EarnableOrder } from '../domain/earning.js';

/** Subset of the orders/* webhook payload we rely on. */
export interface ShopifyOrderPayload {
  id: number; name: string; email?: string | null; currency: string;
  financial_status?: string | null; cancelled_at?: string | null; created_at: string; processed_at?: string | null;
  subtotal_price: string; current_subtotal_price?: string; total_price: string;
  discount_codes?: { code: string; amount: string; type: string }[];
  customer?: { id: number; email?: string | null; first_name?: string | null; last_name?: string | null; state?: string; orders_count?: number } | null;
  line_items: { id: number; title: string; quantity: number; price: string; gift_card?: boolean; product_id?: number | null; discount_allocations?: { amount: string }[] }[];
}

export interface ShopifyRefundPayload {
  id: number; order_id: number; created_at: string;
  refund_line_items?: { line_item_id: number; quantity: number; subtotal?: string | number; line_item?: { gift_card?: boolean } }[];
  transactions?: { amount: string; kind: string; status: string }[];
}

export interface ShopifyCustomerPayload {
  id: number; email?: string | null; first_name?: string | null; last_name?: string | null; state?: string; tags?: string; created_at?: string;
}

export const toCents = (v: string | number | null | undefined): number => Math.round(Number(v ?? 0) * 100);

export function toEarnableOrder(o: ShopifyOrderPayload, productTags: Record<number, string[]> = {}): EarnableOrder {
  return {
    shopifyOrderId: o.id,
    name: o.name,
    subtotalAfterDiscountsCents: toCents(o.current_subtotal_price ?? o.subtotal_price),
    totalPaidCents: toCents(o.total_price),
    paidAt: new Date(o.processed_at ?? o.created_at),
    lines: o.line_items.map((l) => ({
      title: l.title,
      quantity: l.quantity,
      discountedTotalCents: toCents(l.price) * l.quantity - (l.discount_allocations ?? []).reduce((s, d) => s + toCents(d.amount), 0),
      isGiftCard: Boolean(l.gift_card),
      productTags: l.product_id ? (productTags[l.product_id] ?? []) : [],
    })),
  };
}

/** Refunded merchandise amount (excluding gift cards), in cents. */
export function refundedBasisCents(r: ShopifyRefundPayload): number {
  return (r.refund_line_items ?? []).filter((li) => !li.line_item?.gift_card).reduce((s, li) => s + toCents(li.subtotal), 0);
}
