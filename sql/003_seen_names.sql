-- Every session name the board has actually been told about, so the settings
-- screen can offer them instead of asking someone to type a name from memory.
-- Typing it by hand is where this went wrong in practice: three of the first
-- four squares had a name that did not match what was arriving (a missing
-- space, a misspelling, a duplicated phrase), and a name that does not match
-- fails silently — the report arrives, nothing moves, and nothing says why.
create table if not exists seen_names (
  user_id  bigint      not null references users(id) on delete cascade,
  name     text        not null,
  hits     int         not null default 1,
  last_at  timestamptz not null default now(),
  primary key (user_id, name)
);
create index if not exists seen_names_recent on seen_names(user_id, last_at desc);
