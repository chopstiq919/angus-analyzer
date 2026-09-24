# Angus Breeding Analyzer — container recipe for Railway.
# Pins the OS, Node version, and every library Chrome needs, so Railway
# builder changes can't break Puppeteer again.
FROM node:20-bookworm-slim

# Shared libraries headless Chrome needs to start (Puppeteer's documented list)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
      libdrm2 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 \
      libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 \
      libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
      libxkbcommon0 libxrandr2 libxrender1 libxss1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (cached between deploys unless package files change).
# Puppeteer downloads its matching Chrome during this step.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Then the app code
COPY . .

ENV NODE_ENV=production
CMD ["node", "server.js"]
