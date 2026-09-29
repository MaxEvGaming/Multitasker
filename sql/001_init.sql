-- One row per person. Kept multi-user from the start because the owner intends
-- to hand this to other people later, and retrofitting tenancy onto a
-- single-user schema means rewriting every query.
create table if not exists users (
  id            bigserial primary key,
  email         text        not null unique,
  password_hash text        not null,
  created_at    timestamptz not null default now()
);

create table if not exists login_sessions (
  token      text        primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists login_sessions_user on login_sessions(user_id);

-- The states and the arrows between them are the user's to define, not ours.
-- Each state carries its own outgoing arrows:
--   left_to / right_to  where a tap on that half of the button goes
--   auto_to             where the task goes on its own — when Claude reports
--                       the session has stopped, or when the estimate runs out
--   runs_timer          whether the ring counts down while sitting here
create table if not exists states (
  id         bigserial primary key,
  user_id    bigint  not null references users(id) on delete cascade,
  name       text    not null,
  colour     text    not null default '#6b7280',
  sort_order int     not null default 0,
  runs_timer boolean not null default false,
  left_to    bigint  references states(id) on delete set null,
  right_to   bigint  references states(id) on delete set null,
  auto_to    bigint  references states(id) on delete set null,
  unique (user_id, name)
);
create index if not exists states_user on states(user_id);

-- Nine slots per user. The row exists even when empty so the grid keeps its
-- shape and a slot can be filled in place.
create table if not exists tasks (
  id               bigserial primary key,
  user_id          bigint      not null references users(id) on delete cascade,
  slot             int         not null check (slot between 0 and 8),
  title            text        not null default '',
  -- what Claude calls the session, e.g. "ProjectOne"; how an incoming report
  -- finds its square
  match_key        text,
  state_id         bigint      references states(id) on delete set null,
  expected_seconds int,
  state_since      timestamptz not null default now(),
  unique (user_id, slot)
);
create index if not exists tasks_user on tasks(user_id);

-- The Slack-shaped inlet. One secret per user, in the URL, exactly as an
-- incoming webhook works — so the existing hook on the owner's PC needs only a
-- new address, not new code.
create table if not exists webhooks (
  token      text        primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists webhooks_user on webhooks(user_id);

-- Where the phone is reachable. Apple's endpoint plus the two keys the browser
-- handed us at subscribe time.
create table if not exists push_subscriptions (
  id         bigserial primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  endpoint   text        not null unique,
  p256dh     text        not null,
  auth       text        not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on push_subscriptions(user_id);

-- Every move, with why. "manual" never notifies; the other two always do.
create table if not exists moves (
  id         bigserial primary key,
  user_id    bigint      not null references users(id) on delete cascade,
  task_id    bigint,
  from_state text,
  to_state   text,
  cause      text        not null check (cause in ('manual', 'signal', 'timeout')),
  at         timestamptz not null default now()
);
create index if not exists moves_user_at on moves(user_id, at desc);
