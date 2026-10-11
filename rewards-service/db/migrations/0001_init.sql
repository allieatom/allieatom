create table if not exists members (
  id                      bigserial primary key,
  shopify_customer_id     bigint unique,
  email                   text not null unique,
  first_name              text,
  last_name               text,
  opted_in_at             timestamptz,
  birthday_month          smallint check (birthday_month between 1 and 12),
  birthday_day            smallint check (birthday_day between 1 and 31),
  birthday_year           smallint,
  tier                    text not null default 'Bronze',
  tier_ends_at            timestamptz,
  referral_code           text unique,
  referred_by_member_id   bigint references members(id),
  points_balance          integer not null default 0 check (points_balance >= 0),
  points_earned_total     integer not null default 0,
  points_expire_at        timestamptz,
  legacy_yotpo_customer_id bigint,
  locked                  boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists point_transactions (
  id                bigserial primary key,
  member_id         bigint not null references members(id),
  kind              text not null check (kind in ('earn','redeem','adjust','expire','reverse','import')),
  points            integer not null,
  reason            text not null,
  campaign_key      text,
  shopify_order_id  bigint,
  redemption_id     bigint,
  idempotency_key   text unique,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);
create index if not exists point_transactions_member_idx on point_transactions (member_id, occurred_at desc);
create index if not exists point_transactions_order_idx on point_transactions (shopify_order_id);

create table if not exists redemptions (
  id                   bigserial primary key,
  member_id            bigint not null references members(id),
  option_key           text not null,
  title                text not null,
  points_spent         integer not null check (points_spent > 0),
  discount_type        text not null check (discount_type in ('fixed_amount','percentage','free_shipping')),
  discount_value       numeric(10,2) not null,
  code                 text unique,
  shopify_discount_id  text,
  status               text not null default 'pending' check (status in ('pending','issued','used','reversed','failed')),
  failure_reason       text,
  created_at           timestamptz not null default now(),
  issued_at            timestamptz,
  used_at              timestamptz,
  used_order_id        bigint
);
create index if not exists redemptions_member_idx on redemptions (member_id, created_at desc);

create table if not exists referrals (
  id                   bigserial primary key,
  referrer_member_id   bigint not null references members(id),
  referred_email       text,
  referred_member_id   bigint references members(id),
  friend_code          text unique,
  status               text not null default 'shared' check (status in ('shared','clicked','signed_up','completed','reversed')),
  completed_order_id   bigint,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  reversed_at          timestamptz
);
create index if not exists referrals_referrer_idx on referrals (referrer_member_id);

create table if not exists orders_seen (
  shopify_order_id   bigint primary key,
  member_id          bigint references members(id),
  order_name         text,
  basis_cents        integer not null,
  points_awarded     integer not null default 0,
  paid_at            timestamptz,
  cancelled_at       timestamptz,
  refunded_cents     integer not null default 0,
  created_at         timestamptz not null default now()
);

create table if not exists processed_webhooks (
  webhook_id   text primary key,
  topic        text not null,
  received_at  timestamptz not null default now()
);

create table if not exists outbox (
  id               bigserial primary key,
  channel          text not null check (channel in ('klaviyo_event','klaviyo_profile','shopify_tags','shopify_metafields')),
  payload          jsonb not null,
  status           text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index if not exists outbox_pending_idx on outbox (status, next_attempt_at);

create table if not exists audit_log (
  id          bigserial primary key,
  actor       text not null,
  action      text not null,
  member_id   bigint,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
