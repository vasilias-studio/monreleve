# syntax=docker/dockerfile:1
# ============================================================
# MonRelevé — image de production (Node 20 + SQLite persisté sur /data)
#   docker build -t monreleve .
#   docker run -d -p 4000:4000 -v monreleve-data:/data monreleve
# La BASE VIT DANS /data (monreleve.db, secret.key, uploads/) : ce volume
# est la seule chose à sauvegarder/à monter pour ne rien perdre.
# ============================================================

# ---- 1) construction : dépendances compilées (better-sqlite3) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 2) exécution : image minimale, sans outils de compilation ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=4000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY client ./client
COPY tools ./tools
# le classeur source sert au seed automatique d'une base neuve (sans lui, seed partiel)
COPY Relev-de-notes.xlsx ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
