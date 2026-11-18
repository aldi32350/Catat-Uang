# Catat Uang — image untuk VPS
FROM node:24-alpine

# tzdata: supaya "hari ini" & jam transaksi memakai WIB (SQLite membaca zona waktu dari sistem)
RUN apk add --no-cache tzdata
ENV TZ=Asia/Jakarta \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

# data/ (database, sesi WhatsApp, data OCR) disimpan di volume, bukan di image
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
