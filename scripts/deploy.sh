#!/usr/bin/env bash
#
# Deploy Grindly, in the order that keeps the site up when something is wrong.
#
#     ./scripts/deploy.sh              # build, migrate, restart, verify
#     ./scripts/deploy.sh --no-build   # skip the image build
#
# The ordering is the whole point, and it was learned the expensive way.
#
# `migrate` used to be a dependency of `web` with
# `condition: service_completed_successfully`. That reads as "web will not start
# against a stale schema", which is true, and hides the failure mode: `docker
# compose up -d` STOPS the running web container before it evaluates
# dependencies. So when the migration was refused — correctly, it was about to
# drop a table — there was nothing left serving. The site returned 502 until a
# human noticed.
#
# A refused migration should fail the deploy and leave the version that is
# already running exactly where it is. That is only true if the migration is its
# own step and its failure stops you from taking the next one, which is what the
# `set -e` and the ordering below buy.
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m!!  %s\033[0m\n' "$*" >&2; exit 1; }

BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

BEFORE=$(git rev-parse --short HEAD)

if [ "$BUILD" = "1" ]; then
  say "Building the image"
  docker compose build web || die "build failed — nothing was changed, the site is still on $BEFORE"
fi

# Step one, on its own, before anything is stopped. A failure here costs a
# terminal message and no downtime.
say "Applying the schema"
if ! docker compose run --rm migrate; then
  die "the migration was refused — the site is UNTOUCHED and still serving $BEFORE.

Read the message above. Prisma refuses a destructive change rather than
guessing, and the usual cause is a table it does not know about: anything
created by a script rather than by schema.prisma looked to 'db push' like
something to drop. Declare it in schema.prisma and run this again.

Do NOT add --accept-data-loss to make this go away. That is the guard."
fi

# Only now is it safe to swap the running container.
say "Restarting the stack"
docker compose up -d

say "Waiting for health"
for i in $(seq 1 30); do
  status=$(docker compose ps --format '{{.Service}} {{.Status}}' | awk '/^web /{$1="";print}')
  case "$status" in
    *healthy*) break ;;
  esac
  [ "$i" = "30" ] && die "web never became healthy. It is running the NEW image and may be broken.
Roll back with:  git reset --hard $BEFORE && ./scripts/deploy.sh"
  sleep 2
done

say "Verifying"
docker compose ps --format '{{.Service}}  {{.Status}}'

code=$(docker compose exec -T web node -e \
  "fetch('http://localhost:3000/api/health').then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('000');process.exit(0)})")
[ "$code" = "200" ] || die "health check returned $code"

users=$(docker compose exec -T postgres psql -U grindly -d grindly -tAc 'select count(*) from users' | tr -d '[:space:]')
say "Deployed $(git rev-parse --short HEAD) · health 200 · $users users"
