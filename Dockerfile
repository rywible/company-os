FROM oven/bun:1.4.2-debian AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json index.html ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN bun run build

FROM oven/bun:1.4.2-debian
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-x86_64.tar.gz -o /tmp/litestream.tar.gz \
    && echo 'cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d  /tmp/litestream.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream && rm /tmp/litestream.tar.gz
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# Bun's production install omits this SDK's bundled file: dependency.
COPY --from=build /app/node_modules/@fly/sprites/vendor/client-signals ./node_modules/@fly/sprites/node_modules/@fly/client-signals
COPY --from=build /app/dist ./dist
COPY src ./src
RUN bun -e 'await import("@fly/sprites"); const { Store } = await import("./src/server/store.ts"); const db = new Store(":memory:"); db.close();'
COPY deploy/litestream.yml /etc/litestream.yml
COPY deploy/start.sh /app/start.sh
RUN chmod +x /app/start.sh
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/company.sqlite
EXPOSE 8080
CMD ["/app/start.sh"]
