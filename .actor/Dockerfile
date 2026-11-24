# Playwright base image so the optional headless fallback (renderJs) works; plain-HTTP runs never start a browser.
FROM apify/actor-node-playwright-chrome:22-1.64.1 AS builder

COPY --chown=myuser:myuser package*.json ./
RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser . ./
RUN npm run build

FROM apify/actor-node-playwright-chrome:22-1.64.1

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && node --version \
    && npm --version \
    && rm -rf ~/.npm

COPY --from=builder --chown=myuser:myuser /home/myuser/dist ./dist
COPY --chown=myuser:myuser . ./

CMD ["sh", "-c", "exec node --max-old-space-size=$(( ${ACTOR_MEMORY_MBYTES:-256} * 6 / 10 )) dist/main.js"]
