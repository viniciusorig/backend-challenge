FROM oven/bun:1.4.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun
# exec form: SIGTERM goes straight to bun → Nest shutdown hooks → graceful drain
CMD ["bun", "run", "src/main.ts"]
