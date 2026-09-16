# Build from the repository root: docker build -f apps/cloud/Dockerfile .
FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/cloud/package.json apps/cloud/package.json
RUN npm ci --ignore-scripts
COPY apps/cloud apps/cloud
COPY packages/core/src/hub.ts packages/core/src/hub.ts
RUN node apps/cloud/build.mjs
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/cloud/dist/server.mjs /app/server.mjs
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
