FROM node:24-alpine AS tested
WORKDIR /app
COPY package.json *.mjs ./
COPY test/ ./test/
RUN npm test

FROM node:24-alpine
ENV NODE_ENV=production \
    LINEAR_HOST=0.0.0.0 \
    LINEAR_PORT=8089
WORKDIR /app
COPY --from=tested --chown=node:node /app/package.json /app/*.mjs ./
COPY --chown=node:node scripts/*.mjs ./scripts/
RUN mkdir -p /app/.local-runtime /app/outputs \
    && chown node:node /app/.local-runtime /app/outputs
USER node
EXPOSE 8089
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.LINEAR_PORT || '8089') + '/health', {signal: AbortSignal.timeout(4000)}); if (!r.ok || (await r.json()).service !== 'linear-agent-gateway') process.exit(1);"]
CMD ["node", "server.mjs"]
