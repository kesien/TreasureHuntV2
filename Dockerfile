FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# pg_dump a mentéshez, tar a fotók archiválásához
RUN apk add --no-cache postgresql16-client tar
COPY --from=build /app /app
# Perzisztens könyvtárak (volume-ok) a nem privilegizált felhasználónak
RUN mkdir -p /data/photos /data/backups && chown -R node:node /data
ENV PHOTO_DIR=/data/photos BACKUP_DIR=/data/backups
# A migrációk (./drizzle) és a kliens (../web/dist) a szerver könyvtárához képest keresendők
WORKDIR /app/apps/server
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
