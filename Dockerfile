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
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
COPY --from=build --chown=nextjs:nodejs /app ./
# Pre-create data dirs so the Docker named volume initialises with correct
# ownership (nextjs:nodejs). Without this, the volume starts root-owned and
# the nextjs user can't write resumes/logs → EACCES → upload fails.
RUN mkdir -p /app/data/resumes /app/data/logs \
    && chown -R nextjs:nodejs /app/data
USER nextjs
EXPOSE 3000
CMD ["npm", "start"]
