-- Every login attempt, kept only long enough to rate-limit on. Recorded for
-- failures and successes alike: a burst of successes from one address is worth
-- seeing too, and a successful login is what clears the lockout.
create table if not exists login_attempts (
  id      bigserial   primary key,
  email   text        not null,
  ip      text        not null,
  ok      boolean     not null,
  at      timestamptz not null default now()
);
create index if not exists login_attempts_email_at on login_attempts(lower(email), at desc);
create index if not exists login_attempts_ip_at on login_attempts(ip, at desc);

-- One-time links for a forgotten password. There is no mail server here, so an
-- operator mints the link and hands it over; the row is what makes it single-use
-- and short-lived.
create table if not exists password_resets (
  token      text        primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists password_resets_user on password_resets(user_id);

-- The inlet is open to anyone holding the address, so it needs a ceiling. One
-- row per delivery, counted over a window.
create table if not exists hook_hits (
  id    bigserial   primary key,
  token text        not null,
  at    timestamptz not null default now()
);
create index if not exists hook_hits_token_at on hook_hits(token, at desc);
