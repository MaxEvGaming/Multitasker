#!/bin/bash
# Puts this board behind a Caddy that is already serving something else.
#
#   ./attach-to-caddy.sh board.example.com <caddy-container>
#
# It writes one file — the board's own site block — into the Caddy container's
# config directory, and reloads. It does not touch the other site's config, or
# the file that config lives in, or the repository it comes from. Removing this
# board later is removing that one file.
#
# This half is the board's. The host's Caddy has to be told once that it may
# serve other sites, which is a line in whatever config that host already keeps:
#
#     import /config/sites/*.caddy
#
# That line names nothing and depends on nothing. An import that matches no
# files is valid, so the host is unaffected whether this board is there or not.
#
# Run it again any time — after a rebuild, a new domain, a moved upstream.
set -uo pipefail

# Git Bash on Windows rewrites anything that looks like an absolute Unix path
# into a Windows one before it reaches docker or ssh — /etc/caddy/Caddyfile
# arrives as C:/Program Files/Git/etc/caddy/Caddyfile and nothing is found.
# Ignored on Linux, so it costs nothing to say it always.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

DOMAIN="${1:-}"
CADDY="${2:-}"
UPSTREAM="${UPSTREAM:-taskboard:3040}"

say() { printf '  %s\n' "$*"; }
if [ -z "$DOMAIN" ] || [ -z "$CADDY" ]; then
  echo "usage: $0 <domain> <caddy-container>   [UPSTREAM=name:port]"
  exit 2
fi

docker inspect "$CADDY" >/dev/null 2>&1 || { say "no such container: $CADDY"; exit 2; }

# The host must have been told it may serve other sites. Without that line this
# file is written and simply never read — the board would be silently absent,
# which is the failure mode this whole project exists to avoid.
if ! docker exec "$CADDY" caddy adapt --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  say "the host's Caddyfile does not currently adapt — fix that first"
  exit 1
fi
if ! docker exec "$CADDY" grep -q 'import .*sites' /etc/caddy/Caddyfile 2>/dev/null; then
  say "the host's Caddyfile has no 'import .../sites/*.caddy' line."
  say "Without it this file is written and never read. Add the line first:"
  say ""
  say "    import /config/sites/*.caddy"
  exit 1
fi

# Piped in rather than copied from a temporary file: a local path here would
# have to survive Windows path rewriting, and the content is four lines.
docker exec "$CADDY" mkdir -p /config/sites
docker exec -i "$CADDY" sh -c 'cat > /config/sites/taskboard.caddy' <<EOF
# The task board. Written by its own deploy; nothing else here owns it.
$DOMAIN {
    reverse_proxy $UPSTREAM
}
EOF
say "wrote /config/sites/taskboard.caddy"

# Validate before reloading, so a mistake here cannot take down the site that
# was already being served.
if ! docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  say "the result would not be valid — removing it again and leaving things as they were"
  docker exec "$CADDY" rm -f /config/sites/taskboard.caddy
  exit 1
fi

docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || {
  say "reload failed — removing it again"
  docker exec "$CADDY" rm -f /config/sites/taskboard.caddy
  docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1
  exit 1
}
say "reloaded"

if docker exec "$CADDY" wget -qO- "http://$UPSTREAM/api/health" 2>/dev/null | grep -q '"ok":true'; then
  say "the board answers from inside Caddy"
else
  say "warning: no answer on $UPSTREAM — check the container is running and on"
  say "         the same network as Caddy (docker network connect)"
fi

echo
say "Serving $DOMAIN. To remove it later, and leave no trace:"
say "  docker exec $CADDY rm -f /config/sites/taskboard.caddy"
say "  docker exec $CADDY caddy reload --config /etc/caddy/Caddyfile"
