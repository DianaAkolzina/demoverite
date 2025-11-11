FROM node:18-bookworm-slim

LABEL com.avmsolutions.autoclean="true"

WORKDIR /app

# System packages for Python deps (chromadb, optional embedding extras, etc.)
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev \
    build-essential git curl ca-certificates \
    sqlite3 libsqlite3-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Copy manifests first for better caching
COPY package*.json ./
COPY requirements.txt ./

# Python venv + deps
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" PIP_NO_CACHE_DIR=1

# Install Python requirements
RUN pip install --upgrade pip \
 && pip install -r requirements.txt

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production

# Install Node deps after sources; ignore lifecycle scripts during install
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

# If you actually need a build step, run it explicitly (uncomment if applicable)
# RUN npm run build

# Optional: prefetch model (disabled by default to avoid long builds)
ARG PREFETCH_EMB=0
ARG CHROMA_EMB_MODEL=sentence-transformers/allenai-specter
ENV CHROMA_EMB_MODEL=${CHROMA_EMB_MODEL}
RUN if [ "$PREFETCH_EMB" = "1" ]; then \
      python3 -c "import os; from sentence_transformers import SentenceTransformer; \
      m=os.environ.get('CHROMA_EMB_MODEL','sentence-transformers/allenai-specter'); \
      print('[build] Prefetch embedding model:', m); \
      SentenceTransformer(m)" || true; \
    fi

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node","server/index.js"]
