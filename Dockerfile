FROM node:22-alpine

# Prisma's query engine needs openssl on alpine.
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
RUN npm run build

# The schema is pushed at start rather than baked in, because this exercise ships no generated
# migrations (IMPLEMENTATION_PROMPT.md §3). A real deployment would run migrations as a separate
# job, not from the application container.
CMD ["sh", "-c", "npm run db:push && node dist/src/main.js"]
