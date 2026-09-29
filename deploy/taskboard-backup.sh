#!/bin/bash
# A copy of the board, nightly.
#
# Two things go in the same bundle, because losing either one is a bad night:
#   - the database, which is the boards themselves
#   - the .env, which holds the notification keys. Replace those and every
#     phone that ever registered goes quiet, with nothing to say it has.
#
# This only protects against something going wrong inside the machine. The copy
# that matters is the one pulled off it — see tools/pull-backup.ps1 on the PC.
#
# The first version of this named the Postgres container "postgres", the
# database "taskboard" and the env file "$HOME/taskboard/.env", none of which
# matched the machine it was installed on. With `set -e` it stopped on the first
# of those and said nothing, so it ran every night for weeks and produced no
# copy at all — and nobody found out until a copy was wanted.
#
# So it names nothing it can work out. Everything comes from the .env the board
# is actually running on, and from the network the board is actually joined to.
# What it cannot work out, it says out loud and stops.
#
# The .env is the one thing that cannot be derived. It goes in
# ~/taskboard-config/, kept apart from the repository so a deploy cannot touch
# it — the two older places below are where earlier drafts of the notes put it.
set -uo pipefail

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { say "backup FAILED: $*" >&2; exit 1; }

# Where the board keeps its settings. Told, or found in the two places it has
# been put; anything else has to be said.
if [ -n "${ENV_FILE:-}" ]; then
  [ -f "$ENV_FILE" ] || die "ENV_FILE=$ENV_FILE does not exist"
else
  for candidate in "$HOME/taskboard-config/.env" "$HOME/taskboard/.env" "$HOME/config/.env"; do
    [ -f "$candidate" ] && ENV_FILE="$candidate" && break
  done
  [ -n "${ENV_FILE:-}" ] || die "no .env found — set ENV_FILE=/path/to/.env"
fi

url=$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$url" ] || die "no DATABASE_URL in $ENV_FILE"

# The board container knows which network reaches its database; asking it beats
# naming a container that may be called anything.
container="${BOARD_CONTAINER:-taskboard}"
docker inspect "$container" >/dev/null 2>&1 || die "no container called $container"
net=$(docker inspect "$container" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
[ -n "$net" ] || die "$container is on no network"

dir="${BACKUP_DIR:-$HOME/backups/taskboard}"
mkdir -p "$dir" || die "cannot make $dir"
chmod 700 "$dir"
stamp=$(date -u +%Y%m%d-%H%M%S)
dump="$dir/taskboard-$stamp.dump"

# pg_dump refuses to read a server newer than itself, and a dump taken by a
# newer one restores into an older server with errors. So the tool is the same
# major version as the server — asked, not assumed. Pinning a number is how
# this script came to do nothing at all for weeks.
major=$(printf '%s' "$url" | docker run --rm -i --network "$net" \
  --entrypoint sh postgres:alpine -c 'exec psql -tAX -c "show server_version_num" "$(cat)"' \
  2>/dev/null | tr -dc '0-9')
[ -n "$major" ] || die "could not reach the database on network $net"
major=$((major / 10000))
say "the database is Postgres $major"

# pg_dump out of a throwaway container on the board's own network, so nothing
# has to be installed on the host and no container name is assumed. The URL
# carries the user, the password, the host and the database — it is passed on
# standard input so it never appears in the process list.
printf '%s' "$url" | docker run --rm -i --network "$net" \
  --entrypoint sh "postgres:$major-alpine" -c 'exec pg_dump -Fc "$(cat)"' > "$dump" \
  || die "pg_dump did not run (network=$net, Postgres $major)"

# An empty file is not a backup, and the exit code above does not always catch
# it. A dump of an empty board is still a few kilobytes.
size=$(stat -c%s "$dump" 2>/dev/null || echo 0)
[ "$size" -gt 1000 ] || die "the dump is $size bytes — kept nothing"

cp "$ENV_FILE" "$dir/env-$stamp" || die "cannot copy $ENV_FILE"
chmod 600 "$dump" "$dir/env-$stamp"

# Fourteen nights. The database is measured in megabytes, so this costs nothing
# worth counting, and two weeks is long enough to notice something was wrong.
ls -1t "$dir"/taskboard-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$dir"/env-* 2>/dev/null | tail -n +15 | xargs -r rm -f

say "backed up $(du -h "$dump" | cut -f1) from $ENV_FILE"
