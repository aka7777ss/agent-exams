FROM node:24-alpine

RUN apk add --no-cache sqlite

WORKDIR /app

COPY package.json ./
COPY server.mjs runner.py index.html ./
COPY src ./src
COPY public ./public
COPY data/tasks.json ./data/tasks.json

ENV NODE_ENV=production
ENV PORT=4173
ENV STORAGE_DIR=/app/storage

EXPOSE 4173

CMD ["node", "server.mjs"]
