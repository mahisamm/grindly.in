#!/bin/sh
# Runs as root (see Dockerfile) before dropping to nextjs. Needed because
# build-time chown only seeds a BRAND-NEW named volume — appdata already has
# months of content, so it never gets re-seeded, and any dir that was ever
# touched by a root process (stray `docker exec -u root`, an old image
# without this fix, etc.) stays root-owned forever, silently EACCES-ing every
# resume upload until someone chowns it by hand on the live server.
set -e
mkdir -p /app/data/resumes /app/data/resume_tex /app/data/resume_variants \
         /app/data/screenshots /app/data/browser_profile /app/data/logs
chown -R nextjs:nodejs /app/data
exec gosu nextjs "$@"
