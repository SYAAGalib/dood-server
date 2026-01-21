# syntax=docker/dockerfile:1.6

FROM node:20-bookworm AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    docker.io \
    zip \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install

COPY src ./src

RUN npm run build

FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    docker.io \
    zip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY package*.json ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
