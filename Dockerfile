FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache openssl
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --ignore-scripts

COPY . .
RUN ./node_modules/.bin/prisma generate
RUN ./node_modules/.bin/nest build

EXPOSE 3005
CMD ./node_modules/.bin/prisma migrate deploy && node dist/main