FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /app/data && chown node:node /app/data
COPY --chown=node:node src ./src
COPY --chown=node:node plugins ./plugins
USER node
VOLUME ["/app/data"]
CMD ["node", "src/main.js"]
