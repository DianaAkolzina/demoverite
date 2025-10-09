FROM node:18-bullseye-slim

WORKDIR /app

# System packages for Python runtime
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first for better layer caching
COPY package.json ./
COPY requirements.txt ./

# Install Python deps
RUN python3 -m pip install --no-cache-dir -r requirements.txt

# Copy the rest of the app
COPY . .

ARG STRIP_COMMENTS=1
RUN if [ "$STRIP_COMMENTS" = "1" ]; then python3 scripts/strip_comments.py; fi && \
    chmod +x scripts/entrypoint.sh

ENV PORT=3000 \
    NODE_ENV=production \
    CSV_DIR=CSVex \
    CSV_SOURCE_DIR=CSVex \
    CSV_TARGET_DIR=${CSV_DIR}

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["scripts/entrypoint.sh"]
