# Switched from Nixpacks to an explicit Dockerfile after three straight deploys still
# crashed with the exact same "ImportError: libexpat.so.1: cannot open shared object
# file" from rasterio (app/lst.py) - neither `nixPkgs = [..., "expat", ...]` nor
# `aptPkgs = ["libexpat1", ...]` in nixpacks.toml made it into whatever image Railway
# actually runs, and there's no visibility into why from here. A standard Debian-based
# python image already ships libexpat1 as part of CPython's own pyexpat dependency, so
# this sidesteps the problem entirely instead of continuing to guess at Nixpacks' build/
# runtime image split.
FROM python:3.12-slim

# geos/proj: rasterio/shapely/pyproj's manylinux wheels are usually self-contained, but
# GDAL (rasterio's dependency) doesn't always bundle everything - installing these too
# is cheap insurance against the same class of missing-.so surprise for a different lib.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libexpat1 libgeos-dev libproj-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
