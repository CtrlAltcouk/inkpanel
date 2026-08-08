# The Playwright image ships Chromium with every shared library it needs.
# Installing chromium into a bare image is where hours disappear.
#
# This tag MUST match the playwright version in package.json, or Chromium will
# not be where the npm package looks for it. test/docker.test.ts enforces that.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

ENV DATA_DIR=/data \
    PORT=8080

# Install dependencies first so a source-only change does not re-resolve them.
COPY package.json package-lock.json ./

# --omit=dev is deliberate: tsx is a runtime dependency here because the
# service runs TypeScript directly. Only typescript and @types/* are dev.
RUN npm ci --omit=dev

COPY . .

VOLUME ["/data"]
# 8080 is the panel-facing HTTP/API listener; 8443 is the self-signed HTTPS
# listener used by browsers for the WebSerial Flash tab.
EXPOSE 8080 8443

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
