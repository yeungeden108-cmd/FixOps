FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN corepack enable && pnpm install --no-frozen-lockfile && pnpm exec tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 4100
CMD ["node", "dist/server.js"]
