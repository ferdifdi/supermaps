"""Fetch team survey activities from MAPID's Community Maps / Pin Activities API
and save the raw response as GeoJSON under backend/data/survey_lapangan/.

Uses the existing app.mapid.fetch_activities() client (POST /web/competition/activities),
filtered by the team hashtag, over the Jabodetabek bounding box already defined in
app.config.JABODETABEK_BBOX.

    python fetch_survey_activities.py [hashtag]   # default: KaloMenangKitaJoget
"""

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from app import mapid
from app.config import JABODETABEK_BBOX

OUT_DIR = Path(__file__).parent / "data" / "survey_lapangan"


def bbox_polygon(bbox: tuple[float, float, float, float]) -> dict:
    minx, miny, maxx, maxy = bbox
    return {
        "type": "Polygon",
        "coordinates": [[
            [minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny],
        ]],
    }


async def main():
    hashtag = sys.argv[1] if len(sys.argv) > 1 else "KaloMenangKitaJoget"
    polygon = bbox_polygon(JABODETABEK_BBOX)

    print(f"Fetching activities tagged #{hashtag} over Jabodetabek bbox...")
    activities = await mapid.fetch_activities(polygon, hashtag=[hashtag])
    print(f"Got {len(activities)} activities.")

    features = [
        {
            "type": "Feature",
            "geometry": a["geometry"],
            "properties": {k: v for k, v in a.items() if k != "geometry"},
        }
        for a in activities
        if a.get("geometry")
    ]
    geojson = {"type": "FeatureCollection", "features": features}

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = OUT_DIR / f"activities_{hashtag}_{stamp}.geojson"
    out_path.write_text(json.dumps(geojson, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(features)} features to {out_path}")

    skipped = len(activities) - len(features)
    if skipped:
        print(f"Skipped {skipped} activities with no geometry.")


if __name__ == "__main__":
    asyncio.run(main())
