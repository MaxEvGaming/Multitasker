-- A way in for the second person and everyone after.
--
-- The door has been shut since the first account was made, which was right for
-- one user and useless for any more. Opening it to the world is the other
-- extreme: this is a board with someone's working life on it, not a service
-- looking for signups.
--
-- So: a code, handed over directly, good once. Same shape as the reset links —
-- minted by whoever runs the site, no mail involved, and nothing anyone can
-- request for themselves.
create table if not exists invites (
  code       text        primary key,
  note       text,                                  -- who it was meant for
  created_at timestamptz not null default now(),
  expires_at timestamptz,                           -- null: no expiry
  used_at    timestamptz,
  used_by    bigint      references users(id) on delete set null
);
create index if not exists invites_unused on invites(used_at) where used_at is null;
