FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/prepare-ocr-assets.js ./scripts/prepare-ocr-assets.js
RUN npm ci

COPY . .

EXPOSE 3010

CMD ["npm", "start"]
