FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
# Do NOT set HOST here — vite.config treats HOST during `npm run build`.

COPY package.json package-lock.json* ./
# Dev deps are required to compile the React Router app.
RUN npm ci && npm cache clean --force

COPY . .

RUN chmod +x scripts/start.sh \
  && npx prisma generate \
  && npm run build \
  && ls -la build/server

# Railway injects PORT. start.sh binds 0.0.0.0 and never lets migrate abort boot.
CMD ["sh", "scripts/start.sh"]
