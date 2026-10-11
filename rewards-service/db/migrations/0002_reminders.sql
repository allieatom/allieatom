create table if not exists reminders_sent (
  key        text primary key,
  member_id  bigint references members(id),
  sent_at    timestamptz not null default now()
);
