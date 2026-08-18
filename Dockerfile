FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json .env.example README.md ./
COPY src ./src
COPY tests ./tests
RUN pnpm exec tsc -p tsconfig.json

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/storage/sessions /app/data/media
VOLUME ["/app/storage/sessions", "/app/data/media"]
CMD ["node", "dist/src/index.js"]
