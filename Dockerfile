FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

ENV NODE_ENV=production \
    EMBEDDINGS_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=160

EXPOSE 5000

USER node

CMD ["npm", "start"]
