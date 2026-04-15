# API image — FastAPI + uvicorn (no secrets baked in; use env at runtime).

FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV UVICORN_HOST=0.0.0.0
ENV UVICORN_PORT=8000

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8000

# Port is fixed inside the container; map host port via Compose.
CMD uvicorn main:app --host "${UVICORN_HOST}" --port "${UVICORN_PORT}"
