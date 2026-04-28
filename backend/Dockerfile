FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

FROM node:20-alpine

WORKDIR /app

# Set up non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder --chown=appuser:appgroup /app /app

USER appuser

EXPOSE 3001

CMD ["npm", "start"]
