-- The two doors anyone can knock on before signing in — registering, and
-- asking for a salt — counted per address over a window. Neither of the
-- existing tables fits: login_attempts is keyed by email and pass/fail (a
-- registration has no password to get wrong), hook_hits by a token (there is
-- none yet). One row per call; the window is read in src/security.js.
create table if not exists ip_hits (
  id    bigserial   primary key,
  what  text        not null,
  ip    text        not null,
  at    timestamptz not null default now()
);
create index if not exists ip_hits_what_ip_at on ip_hits(what, ip, at desc);
