FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig*.json ./

ENV NODE_ENV=production

CMD ["node", "--import", "tsx/esm", "src/index.ts"]
