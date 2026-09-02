FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package.json package-lock.json* ./
# Dev deps are required to compile the React Router app.
RUN npm ci && npm cache clean --force

COPY . .

RUN npx prisma generate && npm run build

# Railway injects PORT at runtime. Do not hardcode 3000.
CMD ["sh", "-c", "echo \"[start] HOST=$HOST PORT=$PORT\" && npx prisma migrate deploy && npx react-router-serve ./build/server/index.js"]
