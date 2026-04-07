# Force AMD64 — Camoufox only ships AMD64 binaries
FROM --platform=linux/amd64 python:3.12-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git \
    xvfb xauth \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libgbm1 libgtk-3-0 libxss1 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
    libatspi2.0-0 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN python -m playwright install firefox
RUN python -m playwright install-deps firefox

ENV CAMOUFOX_FETCH_DIR=/camoufox-bin
RUN python -m camoufox fetch

COPY server.py .

# ---- Runtime stage ----
FROM --platform=linux/amd64 python:3.12-slim-bookworm AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libgbm1 libgtk-3-0 libxss1 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
    libatspi2.0-0 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1001 appuser
WORKDIR /home/appuser/app

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /ms-playwright /ms-playwright
COPY --from=builder /camoufox-bin /camoufox-bin
COPY --from=builder /app/server.py .

RUN chown -R appuser:appuser /home/appuser
USER appuser

ENV PYTHONUNBUFFERED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV CAMOUFOX_FETCH_DIR=/camoufox-bin
ENV HOME=/home/appuser
EXPOSE 3000

ENTRYPOINT ["python", "server.py"]
