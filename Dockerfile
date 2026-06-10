FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache openssl
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN ./node_modules/.bin/prisma generate
RUN ./node_modules/.bin/nest build

EXPOSE 10000
CMD ./node_modules/.bin/prisma migrate deploy && node --max-http-header-size=65536 dist/src/main