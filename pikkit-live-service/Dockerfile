# Use a plain Node base and install Playwright's own browser build at build time,
# so the Chromium version always matches whatever "playwright" npm version is installed
# (avoids version-mismatch issues you'd get pinning a separate Microsoft base image).
FROM node:20-slim

WORKDIR /app

# Playwright needs these system libs to run headless Chromium on Debian slim.
RUN npx --yes playwright@1.48.0 --version || true

COPY package*.json ./
RUN npm install

# Installs Chromium + required OS dependencies matching the installed playwright version.
RUN npx playwright install --with-deps chromium

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
