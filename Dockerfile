FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN bun install --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY sageroute.config.example.json ./sageroute.config.example.json
EXPOSE 8787
CMD ["bun", "run", "src/cli.ts", "serve"]
