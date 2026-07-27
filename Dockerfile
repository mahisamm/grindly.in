# Next.js web app (production image).
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-slim AS build
WORKDIR /app
ARG BUILD_ID
ENV NEXT_PUBLIC_BUILD_ID=${BUILD_ID}
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# gosu: lets the entrypoint start as root (to chown the shared volume) then
# drop to nextjs via exec — proper signal forwarding, unlike `su -c`.
RUN apt-get update && apt-get install -y openssl gosu && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs
COPY --from=build --chown=nextjs:nodejs /app ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# Pre-create data dirs so a brand-new named volume initialises with correct
# ownership. This alone isn't enough once the volume already has content
# (see docker-entrypoint.sh) but keeps a fresh volume correct from the start.
RUN mkdir -p /app/data/resumes /app/data/logs \
    && chown -R nextjs:nodejs /app/data
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
