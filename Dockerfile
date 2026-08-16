# Grindly web image.
#
# This container runs BOTH halves: the Next.js server and the Python agent it
# spawns to read, score and render resumes. The previous build kept them apart —
# a node:20-slim web image with no Python at all, and a separate worker image —
# because the worker drove real browsers for minutes at a time and belonged on
# its own box. Rendering a PDF takes about a second, so splitting it would mean
# an HTTP hop, a second image to build, and a queue, to avoid installing an
# interpreter.
#
# The cost is honest: this image carries Python, the agent's wheels, and a
# Chromium build, so it is around 1.2 GB. That is the price of the product's
# core feature working in one place.

# ---- node dependencies -----------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build the Next app ----------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
ARG BUILD_ID
ENV NEXT_PUBLIC_BUILD_ID=${BUILD_ID}
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PYTHON_BIN=/opt/agent-venv/bin/python \
    # Chromium is installed to a shared location rather than into the build
    # user's home, so the unprivileged runtime user can actually reach it. The
    # default (~/.cache/ms-playwright) belongs to whoever ran the install, and
    # "browser not found" at runtime is the result.
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl gosu python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

# Agent dependencies in their own venv, so nothing collides with system python.
COPY agent/requirements.txt /tmp/agent-requirements.txt
RUN python3 -m venv /opt/agent-venv \
    && /opt/agent-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/agent-venv/bin/pip install --no-cache-dir -r /tmp/agent-requirements.txt \
    # --with-deps pulls the system libraries Chromium needs (fonts, nss, gtk).
    # Without them the browser installs and then fails to launch, which surfaces
    # as every rewrite failing while the healthcheck stays green.
    && /opt/agent-venv/bin/playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/* /tmp/agent-requirements.txt

# Fonts, named explicitly rather than left to whatever `--with-deps` happens to
# pull in this month. The resume template depends on these by name, so this is a
# hard dependency of the product and not a nicety.
#
#   fonts-liberation  The template's typeface. Liberation Sans is
#                     metric-compatible with Arial, which is what makes a
#                     rebuild previewed on a developer's Windows machine and one
#                     downloaded from this container lay out identically.
#                     Without it Chromium falls back to DejaVu and every line
#                     breaks somewhere else.
#   fonts-dejavu-core Fallback coverage for symbols Liberation lacks.
#   fonts-noto-core   Non-Latin scripts. A candidate whose name is written in
#                     Devanagari or Tamil renders as empty boxes without it —
#                     silently, with no error anywhere, on the one line of the
#                     document that matters most.
#
# Deliberately its OWN layer, placed after the venv rather than merged into the
# apt-get above. Merged, adding a font invalidates the layer that installs
# Chromium, and the deploy box has 3.9 GB of RAM with a live site holding most
# of it — a rebuild that re-downloads a browser there is how a one-line change
# turns into an OOM during a deploy.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-liberation fonts-dejavu-core fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=nextjs:nodejs /app ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Pre-create the data dirs so a brand-new named volume initialises with the
# right ownership. Not sufficient once the volume already has content — see
# docker-entrypoint.sh, which fixes that case at start.
RUN mkdir -p /app/data/resumes /app/data/variants /app/data/logs \
    && chown -R nextjs:nodejs /app/data

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
