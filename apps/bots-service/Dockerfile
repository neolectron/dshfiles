# Build context: the reviewed production-only pnpm deploy artifact for this app, not the repository or a DSH home.
# Official Node22.23.3, Linux amd64 manifest; verify/review the pin before updating.
FROM node:22.23.3-bookworm-slim@sha256:bbf39cb344bb33c1f2eedb3b45b4a890eecfbac91a4f7bac020a95d4e4ea147e
WORKDIR /app
COPY --chown=node:node . /app
RUN mkdir /data && chmod 700 /data && chown node:node /data
USER node
ENV NODE_ENV=production BOTS_SERVICE_HOST=0.0.0.0 BOTS_SERVICE_PORT=8787 BOTS_SERVICE_DATA_DIR=/data
EXPOSE 8787
CMD ["node", "dist/main.js"]
