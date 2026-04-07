# Force AMD64 — Camoufox only ships AMD64 binaries
FROM --platform=linux/amd64 python:3.12-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git build-essential \
    # Firefox runtime deps
    libgtk-3-0 libx11-xcb1 libxfixes3 libxrandr2 libxtst6 libx11-6 \
    libxcomposite1 libasound2 libdbus-glib-1-2 libnss3 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libatspi2.0-0 libxss1 \
    # Xvfb for virtual display
    xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright Firefox
RUN python -m playwright install firefox
RUN python -m playwright install-deps firefox

# Fetch Camoufox browser binary
RUN python -m camoufox fetch

# Copy server
COPY server.py .

# ---- Runtime stage ----
FROM --platform=linux/amd64 python:3.12-slim-bookworm AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libx11-xcb1 libxfixes3 libxrandr2 libxtst6 libx11-6 \
    libxcomposite1 libasound2 libdbus-glib-1-2 libnss3 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libatspi2.0-0 libxss1 \
    xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1001 appuser
WORKDIR /home/appuser/app

# Copy installed packages + browser binaries from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /root/.cache/ms-playwright /home/appuser/.cache/ms-playwright
COPY --from=builder /root/.cache/camoufox /home/appuser/.cache/camoufox
COPY --from=builder /app/server.py .

RUN chown -R appuser:appuser /home/appuser
USER appuser

ENV PYTHONUNBUFFERED=1
ENV HOME=/home/appuser
EXPOSE 3000

ENTRYPOINT ["python", "server.py"]
