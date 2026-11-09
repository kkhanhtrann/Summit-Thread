FROM node:24-bookworm-slim AS build

WORKDIR /workspace
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN apt-get update \
  && apt-get install --no-install-recommends --yes openssl \
  && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./backend/
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix backend ci --no-fund && npm --prefix web ci --no-fund

COPY backend ./backend
COPY web ./web
RUN npm --prefix web run contracts:generate
RUN npm --prefix backend run build
RUN npm --prefix web run build
RUN npm --prefix backend prune --omit=dev \
  && npm --prefix backend install --no-save --omit=dev prisma@7.10.1

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install --no-install-recommends --yes bash nginx openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /workspace/backend/package.json /app/backend/package.json
COPY --from=build /workspace/backend/prisma.config.ts /app/backend/prisma.config.ts
COPY --from=build /workspace/backend/prisma /app/backend/prisma
COPY --from=build /workspace/backend/dist /app/backend/dist
COPY --from=build /workspace/backend/node_modules /app/backend/node_modules
COPY --from=build /workspace/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/start.sh /app/start.sh
RUN chmod 755 /app/start.sh \
  && mkdir -p /app/.data/recordings \
  && chown -R node:node /app /usr/share/nginx/html

USER node
EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
