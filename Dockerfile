# Single-stage, run as root — avoids all cache path complexity
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

ENV PYTHONUNBUFFERED=1
EXPOSE 3000

ENTRYPOINT ["python", "server.py"]
