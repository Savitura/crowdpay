FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

FROM node:20-alpine

WORKDIR /app

# Set up non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder --chown=appuser:appgroup /app/src /app/src
COPY --from=builder --chown=appuser:appgroup /app/db /app/db
COPY --from=builder --chown=appuser:appgroup /app/package.json /app/package.json
COPY --from=builder --chown=appuser:appgroup /app/package-lock.json /app/package-lock.json
COPY --from=builder --chown=appuser:appgroup /app/public /app/public
RUN npm ci --omit=dev && npm cache clean --force

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENV NODE_ENV=production

CMD ["npm", "start"]
