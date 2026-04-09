FROM node:20-slim

# Install uv (for pi skills that use inline script dependencies)
RUN apt-get update && apt-get install -y curl ca-certificates python3 && \
    curl -LsSf https://astral.sh/uv/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig*.json ./

ENV NODE_ENV=production

CMD ["node", "--import", "tsx/esm", "src/index.ts"]
