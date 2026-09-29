FROM node:22-alpine

WORKDIR /app

# Dependencies first so a change to the source does not re-install them.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY sql ./sql

ENV NODE_ENV=production
ENV PORT=3040
EXPOSE 3040

# Runs the migrations itself on boot, so a deploy is one container restart.
CMD ["node", "src/server.js"]
