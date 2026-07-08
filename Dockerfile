# Sales AI Agent — Node backend + frontend buildado em public/
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Banco "semente": copiado para o volume persistente (/data) na 1ª inicialização.
RUN mkdir -p /app/seed && cp prototype.db /app/seed/prototype.db

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/prototype.db \
    SESSIONS_PATH=/data/.sessions

EXPOSE 3000

CMD ["sh", "-c", "mkdir -p /data && if [ ! -f \"$DB_PATH\" ]; then cp /app/seed/prototype.db \"$DB_PATH\"; fi; exec node --experimental-sqlite server.js"]
