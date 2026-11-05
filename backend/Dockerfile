FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm i --no-save prisma@5
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:4000/health || exit 1
# Migrations + reference data run as a separate release step (never on every start, never seeding users):
#   docker compose run --rm api npm run release      (uses MIGRATION_DATABASE_URL if set, see README)
# First Super Administrator:  docker compose run --rm api npm run admin:bootstrap -- --email … --name … --username …
CMD ["node", "dist/index.js"]
