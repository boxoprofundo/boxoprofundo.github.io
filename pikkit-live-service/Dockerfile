# No browser, no Chromium, no system libs -- this service is now just two
# sets of JSON HTTP calls (see pikkit.js). Build is seconds, image is small,
# and it runs comfortably in the smallest Railway instance.
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
