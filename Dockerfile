FROM node:20-slim

# Install system deps: uv (for pi skills + paperchecker), cron, timezone data
RUN apt-get update && apt-get install -y curl ca-certificates python3 cron tzdata rsync git openssh-client && \
    curl -LsSf https://astral.sh/uv/install.sh | sh && \
    ln -sf /usr/share/zoneinfo/America/New_York /etc/localtime && \
    echo "America/New_York" > /etc/timezone && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:$PATH"
ENV TZ=America/New_York

WORKDIR /app

RUN npm install -g @mariozechner/pi-coding-agent

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig*.json ./
COPY scripts/ ./scripts/
COPY docker-entrypoint.sh ./
RUN chmod +x scripts/run-paperchecker.sh docker-entrypoint.sh

# Schedule paperchecker at 2:00 AM ET daily
RUN echo "0 2 * * * /app/scripts/run-paperchecker.sh >> /var/log/paperchecker.log 2>&1" | crontab -

ENV NODE_ENV=production

ENTRYPOINT ["/app/docker-entrypoint.sh"]
