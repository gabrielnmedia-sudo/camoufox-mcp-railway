# Single-stage build — avoids path issues with camoufox/playwright binary locations
# Force AMD64 — Camoufox only ships AMD64 binaries
FROM --platform=linux/amd64 python:3.12-slim-bookworm

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

RUN python -m playwright install firefox
RUN python -m playwright install-deps firefox
RUN python -m camoufox fetch

COPY server.py .

RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app

# Copy browser caches so appuser can find them
RUN mkdir -p /home/appuser/.cache && \
    cp -r /root/.cache/ms-playwright /home/appuser/.cache/ms-playwright && \
    cp -r /root/.cache/camoufox /home/appuser/.cache/camoufox && \
    chown -R appuser:appuser /home/appuser/.cache

USER appuser

ENV PYTHONUNBUFFERED=1
ENV HOME=/home/appuser
EXPOSE 3000

ENTRYPOINT ["python", "server.py"]
