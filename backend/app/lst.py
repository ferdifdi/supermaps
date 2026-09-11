"""Land Surface Temperature (LST) rasters for M-UC1's "Kenyamanan" tab, replacing the old
coarse MAPID Urban Heat Island polygon there (K-UC2's resilience() keeps that UHI layer
unchanged - this module is M-UC1-only, a completely separate data path).

Source: backend/data/lst/LST AST MAPID/LST AST MAPID/{LST MUSIM HUJAN,LST KEMARAU}.tif,
two seasonal LST rasters (deg C) from AST imagery, classified per
"panduan klasifikasi LST dan AST.pdf" into 5 classes each. Wet-season raster is already
EPSG:4326 (plain lon/lat); dry-season raster is EPSG:32648 (UTM 48S) so query points are
reprojected before sampling. Both rasters have no explicit nodata sentinel - the full band
is read as-is, only out-of-bounds centroids are skipped.

Rasters are opened once at import (module-level cache), same "load once, keep in memory"
pattern as static_poi.py/mapid_environment.py's lazy _layers cache, except here there are
only two fixed files so there's nothing to key by name/mode - just load both up front.
"""

from datetime import datetime
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.transform import rowcol

from .geo import fc, feature, to_deg

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "lst" / "LST AST MAPID" / "LST AST MAPID"

# label -> (kelas, upper_bound_exclusive, color); rows are checked in order, first match wins.
_WET_BINS = [
    (1, 22.0, "Sangat Sejuk", "#0000FF"),
    (2, 25.0, "Sejuk", "#00FFFF"),
    (3, 28.0, "Sedang", "#FFFF00"),
    (4, 32.0, "Panas", "#FFA500"),
    (5, float("inf"), "Sangat Panas", "#FF0000"),
]
_DRY_BINS = [
    (1, 26.0, "Sangat Sejuk", "#0000FF"),
    (2, 29.0, "Sejuk", "#00FFFF"),
    (3, 32.0, "Sedang", "#FFFF00"),
    (4, 36.0, "Panas", "#FFA500"),
    (5, float("inf"), "Sangat Panas", "#FF0000"),
]

_to_utm48s = Transformer.from_crs("EPSG:4326", "EPSG:32648", always_xy=True).transform

_rasters: dict[str, dict] = {}


def _load():
    if _rasters:
        return
    for season, filename in (("hujan", "LST MUSIM HUJAN.tif"), ("kemarau", "LST KEMARAU.tif")):
        path = DATA_DIR / filename
        with rasterio.open(path) as ds:
            _rasters[season] = {
                "array": ds.read(1),
                "transform": ds.transform,
                "crs": ds.crs,
                "bounds": ds.bounds,
                "shape": ds.shape,
            }


def season_for_month(month: int) -> str:
    """BMKG convention: musim kemarau = April-September, musim hujan = Oktober-Maret."""
    return "kemarau" if 4 <= month <= 9 else "hujan"


def current_season() -> str:
    return season_for_month(datetime.now().month)


def classify(temp_c: float, season: str) -> dict:
    bins = _DRY_BINS if season == "kemarau" else _WET_BINS
    for kelas, upper, label, color in bins:
        if temp_c < upper:
            return {"kelas": kelas, "label": label, "color": color}
    # unreachable (last bin upper is +inf), kept for safety
    kelas, _, label, color = bins[-1]
    return {"kelas": kelas, "label": label, "color": color}


def _sample(season: str, lon: float, lat: float) -> float | None:
    """Sample the season's raster at a WGS84 lon/lat, reprojecting first if that raster's
    CRS isn't EPSG:4326. Returns None if the point falls outside the raster's bounds/array."""
    _load()
    r = _rasters[season]
    if r["crs"] and r["crs"].to_epsg() != 4326:
        x, y = _to_utm48s(lon, lat)
    else:
        x, y = lon, lat
    b = r["bounds"]
    if not (b.left <= x <= b.right and b.bottom <= y <= b.top):
        return None
    row, col = rowcol(r["transform"], x, y)
    nrows, ncols = r["shape"]
    if not (0 <= row < nrows and 0 <= col < ncols):
        return None
    value = r["array"][row, col]
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    return float(value)


def sample_grid(cells: list, season: str | None = None) -> dict:
    """cells: metric-CRS polygons (e.g. from geo.grid()) - one Feature per cell whose
    centroid falls inside the season's raster, geometry is the cell polygon (reprojected
    to WGS84 like every other analysis.py grid), properties carry SUHU/KELAS/CLASS/
    kelas_num so both the fill-color match expression (CLASS) and the dock's grouping
    logic (KELAS) work off the same feature."""
    season = season or current_season()
    features = []
    for i, c in enumerate(cells):
        centroid_deg = to_deg(c.centroid)
        lon, lat = centroid_deg.x, centroid_deg.y
        temp_c = _sample(season, lon, lat)
        if temp_c is None:
            continue
        info = classify(temp_c, season)
        features.append(feature(c, {
            "grid_id": i + 1,  # same scan-order index as analysis.py's grid/green_grid,
            # so a cell number means the same thing across every 250m-grid layer
            "SUHU": round(temp_c, 1),
            "KELAS": info["label"],
            "CLASS": info["label"],
            "kelas_num": info["kelas"],
            "color": info["color"],
        }))
    return fc(features)
