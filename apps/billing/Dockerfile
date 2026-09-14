FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
ENV NODE_ENV=production \
    DEVICE_DECK_BILLING_HOST=0.0.0.0 \
    DEVICE_DECK_BILLING_PORT=8080 \
    DEVICE_DECK_BILLING_HOME=/data \
    DEVICE_DECK_BILLING_CONFIG=/config/billing.json
WORKDIR /app
COPY --chown=node:node dist/ /app/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
