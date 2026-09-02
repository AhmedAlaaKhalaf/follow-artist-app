FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
# Do NOT set HOST here — vite.config treats HOST during `npm run build`.
# Bind address is set only at runtime in CMD.

COPY package.json package-lock.json* ./
# Dev deps are required to compile the React Router app.
RUN npm ci && npm cache clean --force

COPY . .

RUN npx prisma generate && npm run build

# Railway injects PORT at runtime. Listen on 0.0.0.0 so the proxy can reach us.
CMD ["sh", "-c", "export HOST=0.0.0.0; echo \"[start] HOST=$HOST PORT=$PORT\"; npx prisma migrate deploy && npx react-router-serve ./build/server/index.js"]
