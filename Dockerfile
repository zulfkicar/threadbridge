FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node wrangler.jsonc worker-configuration.d.ts ./
COPY --chown=node:node test ./test
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node scripts ./scripts
RUN mkdir -p .wrangler .data node_modules/.mf && chown node:node .wrangler .data node_modules/.mf
USER node
ENV WRANGLER_SEND_METRICS=false CI=1
EXPOSE 8875
CMD ["npx","wrangler","dev","--ip","0.0.0.0","--port","8875"]
