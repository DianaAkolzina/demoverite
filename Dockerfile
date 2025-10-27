FROM node:18-bookworm-slim

WORKDIR /app

# System packages for Python runtime
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv ca-certificates sqlite3 libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first for better layer caching
COPY package*.json ./
COPY requirements.txt ./

# Create isolated Python environment (PEP 668 safe) and install deps
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -r requirements.txt

# Install Node.js deps (production only)
# Use npm install with dev dependencies omitted to avoid lockfile sync issues with npm ci
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

ARG STRIP_COMMENTS=1
RUN if [ "$STRIP_COMMENTS" = "1" ]; then python3 scripts/strip_comments.py; fi && \
    chmod +x scripts/entrypoint.sh

ENV PORT=3000 \
    NODE_ENV=production

# Optional: prefetch sentence-transformers model (can be overridden at runtime)
# Default to a public, science-oriented, commercially usable model
# (AllenAI SPECTER via Sentence-Transformers wrapper)
ARG CHROMA_EMB_MODEL=sentence-transformers/allenai-specter
ENV CHROMA_EMB_MODEL=${CHROMA_EMB_MODEL}
RUN python3 -c "import os; from sentence_transformers import SentenceTransformer; m=os.environ.get('CHROMA_EMB_MODEL','sentence-transformers/allenai-specter'); print('[build] Prefetch embedding model:', m); SentenceTransformer(m)" || true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["scripts/entrypoint.sh"]
