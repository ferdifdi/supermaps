"""Trotoar (sidewalk) quality analysis pipeline — model setup + one-off run, NOT wired
into any use case yet. Reads the field-survey photos already fetched by
fetch_survey_activities.py and produces a per-photo and per-activity quality score.

Two models, per spec:

1. Object detection: ultralytics YOLOv8n (`yolov8n.pt`), COCO-pretrained, auto-downloaded
   through the official ultralytics release mechanism. COCO's 80 classes do NOT include
   "sidewalk", "crosswalk"/"pedestrian crossing", "tree", or "streetlight" — there is no
   off-the-shelf detector for those. So YOLO here is a SECONDARY/supplementary signal only,
   using COCO classes as loose proxies:
     - person            -> pedestrian presence / potential obstruction on the sidewalk
     - bicycle           -> non-pedestrian traffic sharing the sidewalk
     - car/truck/bus     -> vehicle encroachment (parked/blocking vehicles)
     - traffic light     -> rough proxy for a signalised crossing nearby
     - potted plant/bench -> street furniture proxy (amenity presence)

2. Semantic segmentation: the spec asked for "DeepLabV3-family". Torchvision's shipped
   DeepLabV3 checkpoints are COCO-with-VOC-labels (21 classes: person, car, chair, potted
   plant, ...) or ImageNet-backbone only — again, no "sidewalk" class, and there is no
   official, freely-downloadable DeepLabV3 checkpoint trained on Cityscapes reachable
   without guessing a private/unofficial URL. Cityscapes IS the label set that actually
   has `sidewalk`, `road`, `vegetation`, `pole`, `traffic light` etc., and Hugging Face
   hosts a legitimate, officially-published Cityscapes-pretrained checkpoint:
   `nvidia/segformer-b0-finetuned-cityscapes-1024-1024` (Segformer architecture, loaded
   via `transformers` official `from_pretrained`, not a hand-built URL). We substitute
   Segformer-cityscapes for DeepLabV3 here — both are semantic segmentation architectures,
   the swap only changes the backbone/head design, not the task. Segmentation is the
   PRIMARY source for sidewalk-quality metrics since Cityscapes has `sidewalk`, `road`,
   `vegetation`, and `pole` as direct classes; YOLO is secondary/supplementary.

This is a best-effort proxy pipeline built from the closest legitimately-available public
models, not a purpose-built sidewalk-quality-scoring model (none exists as a simple public
download). Do not treat the composite score as validated/calibrated ground truth.

Runs on GPU (CUDA) when available, since both models are small enough to comfortably fit
in a 4GB card one photo at a time; falls back to CPU automatically otherwise.

    python analyze_sidewalk_quality.py [geojson_path]
"""

import json
import mimetypes
import sys
from pathlib import Path

import httpx
import torch
from PIL import Image
from transformers import AutoImageProcessor, SegformerForSemanticSegmentation
from ultralytics import YOLO

DATA_DIR = Path(__file__).parent / "data" / "survey_lapangan"
DEFAULT_GEOJSON = DATA_DIR / "activities_KaloMenangKitaJoget_20260911_055132.geojson"
PHOTOS_DIR = DATA_DIR / "photos"
ANALYSIS_DIR = DATA_DIR / "analysis"

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# COCO class names (as proxies) YOLOv8n can actually detect that are relevant here.
YOLO_PROXY_CLASSES = {
    "person": "pedestrian_presence",
    "bicycle": "non_pedestrian_traffic",
    "car": "vehicle_encroachment",
    "truck": "vehicle_encroachment",
    "bus": "vehicle_encroachment",
    "traffic light": "crossing_signal_proxy",
    "potted plant": "street_furniture",
    "bench": "street_furniture",
}

# Cityscapes classes (segformer label ids) we report pixel-% for.
CITYSCAPES_CLASSES_OF_INTEREST = ["road", "sidewalk", "vegetation", "pole", "traffic light", "person"]

YOLO_CONF_THRESHOLD = 0.25


def is_image_url(url: str) -> bool:
    guess, _ = mimetypes.guess_type(url)
    if guess and guess.startswith("image/"):
        return True
    return url.lower().split("?")[0].endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp"))


def download_photos(features: list[dict]) -> dict[str, list[Path]]:
    """Download every media URL per activity into data/survey_lapangan/photos/<activity_id>/.
    Returns {activity_id: [local_paths]}. Skips non-image URLs and logs failed downloads."""
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    result: dict[str, list[Path]] = {}
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        for feat in features:
            props = feat["properties"]
            activity_id = props["_id"]
            urls = props.get("medias") or []
            local_paths = []
            act_dir = PHOTOS_DIR / activity_id
            for i, url in enumerate(urls):
                if not is_image_url(url):
                    print(f"  skip (not image ext/type): {url}")
                    continue
                ext = Path(url.split("?")[0]).suffix or ".jpg"
                out_path = act_dir / f"{i}{ext}"
                if out_path.exists() and out_path.stat().st_size > 0:
                    local_paths.append(out_path)
                    continue
                try:
                    r = client.get(url)
                    r.raise_for_status()
                    content_type = r.headers.get("content-type", "")
                    if not content_type.startswith("image/") and not is_image_url(url):
                        print(f"  skip (response not image, {content_type}): {url}")
                        continue
                    act_dir.mkdir(parents=True, exist_ok=True)
                    out_path.write_bytes(r.content)
                    # verify it actually opens as an image
                    with Image.open(out_path) as im:
                        im.verify()
                    local_paths.append(out_path)
                except Exception as e:
                    print(f"  FAILED download {url}: {e}")
            result[activity_id] = local_paths
            print(f"[{activity_id}] {props.get('title', '')!r}: {len(local_paths)}/{len(urls)} photos ok")
    return result


def is_location_thumbnail(photo_path: Path) -> bool:
    """The survey app's export always puts a static map/location-pin screenshot as the
    first media item per activity (local filename "0.<ext>", see download_photos) - not
    an actual street/sidewalk photo. It scores a hard 0 on every segmentation class and
    was dragging every activity's average down, so it's excluded from scoring entirely."""
    return photo_path.stem == "0"


def run_yolo(model: YOLO, image_path: Path):
    """Run YOLOv8n. Returns (detections, raw_results) - raw_results is kept so the caller
    can render an annotated overlay without re-running inference."""
    results = model.predict(source=str(image_path), device=DEVICE, conf=YOLO_CONF_THRESHOLD, verbose=False)
    detections = []
    for res in results:
        names = res.names
        for box in res.boxes:
            cls_name = names[int(box.cls[0])]
            if cls_name not in YOLO_PROXY_CLASSES:
                continue
            detections.append({
                "class": cls_name,
                "proxy_for": YOLO_PROXY_CLASSES[cls_name],
                "confidence": round(float(box.conf[0]), 4),
                "bbox_xyxy": [round(v, 1) for v in box.xyxy[0].tolist()],
            })
    return detections, results


def run_segformer(processor, model, image_path: Path):
    """Run Segformer-cityscapes. Returns (percentages, pred_mask, label2id) - the raw
    mask is kept so the caller can build a colored overlay without re-running inference."""
    image = Image.open(image_path).convert("RGB")
    inputs = processor(images=image, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        outputs = model(**inputs)
    logits = outputs.logits  # (1, num_labels, H/4, W/4)
    upsampled = torch.nn.functional.interpolate(
        logits, size=image.size[::-1], mode="bilinear", align_corners=False
    )
    pred = upsampled.argmax(dim=1)[0].cpu()  # (H, W) class ids
    total_px = pred.numel()
    id2label = model.config.id2label
    label2id = {v: k for k, v in id2label.items()}

    percentages = {}
    for cls_name in CITYSCAPES_CLASSES_OF_INTEREST:
        cls_id = label2id.get(cls_name)
        if cls_id is None:
            percentages[cls_name] = 0.0
            continue
        pct = (pred == cls_id).sum().item() / total_px * 100
        percentages[cls_name] = round(pct, 2)
    return percentages, pred, label2id


# Colors match this project's WebGIS vocabulary (see frontend/src/usecases.js's
# green_grid/lst ramps) instead of raw Cityscapes/COCO class names - "vegetation" here
# stands in for pohon/kanopi/teduhan hijau since Cityscapes has no separate tree-canopy
# class, and Cityscapes "sidewalk"/"road" map directly to trotoar/jalan.
SEG_OVERLAY_CLASSES = {
    "sidewalk": {"label_id": "Trotoar", "color": (59, 130, 246)},        # blue
    "vegetation": {"label_id": "Kanopi / Pohon / Teduhan Hijau", "color": (22, 163, 74)},  # green
    "road": {"label_id": "Jalan", "color": (107, 114, 128)},             # gray
    "pole": {"label_id": "Tiang (proxy lampu jalan)", "color": (245, 158, 11)},  # amber
}
YOLO_LABEL_ID = {
    "pedestrian_presence": "Orang",
    "non_pedestrian_traffic": "Sepeda",
    "vehicle_encroachment": "Kendaraan",
    "crossing_signal_proxy": "Lampu Lalu Lintas",
    "street_furniture": "Fasilitas Jalan",
}


def save_analysis_overlay(image_path: Path, pred_mask, label2id: dict, detections: list[dict], seg_pct: dict, score_info: dict, out_path: Path, alpha: float = 0.45):
    """Colored overlay in this project's own vocabulary (trotoar/kanopi-pohon/jalan from
    segmentation) with YOLO detection boxes drawn on top in Indonesian labels - this is
    the "gambar analisis AI" meant to sit next to the raw survey photo in the UI, so it
    has to read in webgis terms, not raw Cityscapes/COCO class names."""
    import numpy as np
    from PIL import ImageDraw, ImageFont

    image = Image.open(image_path).convert("RGB")
    arr = np.array(image).astype(np.float32)
    mask_np = pred_mask.numpy()
    overlay = arr.copy()
    for cls_name, spec in SEG_OVERLAY_CLASSES.items():
        cls_id = label2id.get(cls_name)
        if cls_id is None:
            continue
        m = mask_np == cls_id
        if not m.any():
            continue
        color = np.array(spec["color"], dtype=np.float32)
        overlay[m] = overlay[m] * (1 - alpha) + color * alpha
    blended = Image.fromarray(overlay.astype(np.uint8))

    draw = ImageDraw.Draw(blended)
    try:
        font = ImageFont.truetype("arial.ttf", 18)
        font_small = ImageFont.truetype("arial.ttf", 15)
    except Exception:
        # No system TrueType font found (e.g. non-Windows box) - default bitmap font is
        # tiny but always available, better than crashing the whole pipeline over text size.
        font = font_small = ImageFont.load_default()

    for d in detections:
        x0, y0, x1, y1 = d["bbox_xyxy"]
        label = YOLO_LABEL_ID.get(d["proxy_for"], d["proxy_for"])
        draw.rectangle([x0, y0, x1, y1], outline=(239, 68, 68), width=3)
        draw.rectangle([x0, max(0, y0 - 20), x0 + 9 * len(label) + 8, y0], fill=(239, 68, 68))
        draw.text((x0 + 4, max(0, y0 - 19)), label, fill=(255, 255, 255), font=font_small)

    # Caption bar: what the colors mean + the actual percentages/score, in plain text -
    # a color blend alone doesn't tell a viewer "this blue patch is 3.1% of the frame",
    # the numbers are what the composite score is actually computed from.
    w, h = blended.size
    lines = [
        f"Trotoar: {seg_pct.get('sidewalk', 0):.1f}%   "
        f"Kanopi/Pohon: {seg_pct.get('vegetation', 0):.1f}%   "
        f"Jalan: {seg_pct.get('road', 0):.1f}%",
        f"Skor Kualitas Trotoar: {score_info['composite_score']} ({score_info['label']})",
    ]
    bar_h = 22 * len(lines) + 12
    draw.rectangle([0, h - bar_h, w, h], fill=(17, 24, 39, 220))
    for i, line in enumerate(lines):
        draw.text((10, h - bar_h + 8 + i * 22), line, fill=(255, 255, 255), font=font)
    # Small color-swatch legend next to the caption bar so "which color is which class"
    # doesn't have to be memorized from the class list above.
    legend_x = w - 190
    legend_y = h - bar_h + 8
    for cls_name, spec in [("sidewalk", SEG_OVERLAY_CLASSES["sidewalk"]), ("vegetation", SEG_OVERLAY_CLASSES["vegetation"])]:
        draw.rectangle([legend_x, legend_y, legend_x + 14, legend_y + 14], fill=spec["color"])
        draw.text((legend_x + 20, legend_y - 2), spec["label_id"].split(" / ")[0], fill=(255, 255, 255), font=font_small)
        legend_y += 20

    # JPEG, not PNG: these are photographic overlays (not flat-color graphics), so PNG's
    # lossless compression barely helps - 44 of them came to 130MB as PNG vs 6.4MB as
    # JPEG q=80, and that difference is the git repo's problem forever once committed.
    out_path.parent.mkdir(parents=True, exist_ok=True)
    blended.convert("RGB").save(out_path, format="JPEG", quality=80, optimize=True)


def composite_score(seg_pct: dict[str, float], detections: list[dict]) -> dict:
    """Simple, transparent composite score (0-100) + label bucket.

    Components (all 0-100, higher = better sidewalk quality signal):
      - sidewalk_present_score: scaled sidewalk pixel-% (segmentation is ground truth
        for "does a sidewalk actually exist in frame"). Capped at 30% sidewalk coverage
        -> 100 (a photo framed mostly on the sidewalk itself is already "fully present").
      - shade_score: scaled vegetation pixel-% as a proxy for tree shade coverage.
        Capped at 25% vegetation -> 100.
      - obstruction_score: 100 minus a penalty for detected people/vehicles overlapping
        the frame (YOLO detection COUNT, not IoU with the sidewalk mask, since we don't
        have per-instance segmentation of the sidewalk polygon) - each vehicle detection
        costs more than a pedestrian since vehicles blocking a sidewalk are worse.

    composite = weighted average: 50% sidewalk_present, 25% shade, 25% obstruction.
    This is a deliberately simple, explainable starting point - NOT a validated metric.
    """
    sidewalk_present_score = min(100.0, seg_pct.get("sidewalk", 0.0) / 30.0 * 100)
    shade_score = min(100.0, seg_pct.get("vegetation", 0.0) / 25.0 * 100)

    vehicle_ct = sum(1 for d in detections if d["proxy_for"] == "vehicle_encroachment")
    person_ct = sum(1 for d in detections if d["proxy_for"] == "pedestrian_presence")
    penalty = min(100.0, vehicle_ct * 20 + person_ct * 5)
    obstruction_score = 100.0 - penalty

    composite = 0.5 * sidewalk_present_score + 0.25 * shade_score + 0.25 * obstruction_score
    composite = round(composite, 1)

    if composite >= 66:
        label = "Baik"
    elif composite >= 40:
        label = "Sedang"
    else:
        label = "Buruk"

    return {
        "composite_score": composite,
        "label": label,
        "components": {
            "sidewalk_present_score": round(sidewalk_present_score, 1),
            "shade_score": round(shade_score, 1),
            "obstruction_score": round(obstruction_score, 1),
        },
    }


def main():
    geojson_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_GEOJSON
    print(f"Loading {geojson_path} ...")
    data = json.loads(geojson_path.read_text(encoding="utf-8"))
    features = data["features"]
    print(f"{len(features)} activities.")

    print("\n--- Downloading photos ---")
    photos_by_activity = download_photos(features)
    total_photos = sum(len(v) for v in photos_by_activity.values())
    print(f"\n{total_photos} photos downloaded/verified total.")

    print(f"\n--- Loading models (device={DEVICE}) ---")
    yolo_model = YOLO("yolov8n.pt")
    yolo_model.to(DEVICE)

    seg_name = "nvidia/segformer-b0-finetuned-cityscapes-1024-1024"
    seg_processor = AutoImageProcessor.from_pretrained(seg_name)
    seg_model = SegformerForSemanticSegmentation.from_pretrained(seg_name).to(DEVICE)
    seg_model.eval()

    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    overlays_dir = ANALYSIS_DIR / "overlays"
    overlays_dir.mkdir(parents=True, exist_ok=True)
    photo_results = []
    activity_features = []

    for feat in features:
        props = feat["properties"]
        activity_id = props["_id"]
        title = props.get("title", "")
        description = props.get("description", "")
        geometry = feat["geometry"]
        photos = photos_by_activity.get(activity_id, [])

        activity_photo_scores = []
        for photo_path in photos:
            if is_location_thumbnail(photo_path):
                print(f"  skip (location thumbnail, not a street photo): {photo_path.name}")
                continue
            try:
                detections, _yolo_results = run_yolo(yolo_model, photo_path)
                seg_pct, pred_mask, label2id = run_segformer(seg_processor, seg_model, photo_path)
                score_info = composite_score(seg_pct, detections)
            except Exception as e:
                print(f"  FAILED analysis on {photo_path}: {e}")
                continue

            # Annotated overlay in this project's own vocabulary (trotoar/kanopi-pohon/
            # jalan color blend from segmentation + detection boxes in Indonesian labels)
            # saved for every analyzed photo - the "gambar analisis AI" meant to sit next
            # to the raw survey photo in the UI, matching the same numbers saved below
            # (photo_results.json) rather than raw Cityscapes/COCO class names.
            overlay_rel_path = None
            try:
                overlay_dir = overlays_dir / activity_id
                out_path = overlay_dir / f"{photo_path.stem}_analisis.jpg"
                save_analysis_overlay(photo_path, pred_mask, label2id, detections, seg_pct, score_info, out_path)
                overlay_rel_path = str(out_path.relative_to(DATA_DIR)).replace("\\", "/")
            except Exception as e:
                print(f"  FAILED overlay for {photo_path}: {e}")

            photo_result = {
                "activity_id": activity_id,
                "photo": str(photo_path.relative_to(DATA_DIR)).replace("\\", "/"),
                "overlay": overlay_rel_path,
                "detections": detections,
                "segmentation_pct": seg_pct,
                **score_info,
            }
            photo_results.append(photo_result)
            activity_photo_scores.append(photo_result)
            print(f"  {photo_path.name}: score={score_info['composite_score']} ({score_info['label']}) "
                  f"sidewalk%={seg_pct.get('sidewalk')} vegetation%={seg_pct.get('vegetation')} "
                  f"detections={len(detections)}")

        if not activity_photo_scores:
            print(f"[{activity_id}] {title!r}: no analyzable photos, skipping activity summary.")
            continue

        n = len(activity_photo_scores)
        avg_composite = round(sum(p["composite_score"] for p in activity_photo_scores) / n, 1)
        avg_components = {
            k: round(sum(p["components"][k] for p in activity_photo_scores) / n, 1)
            for k in ("sidewalk_present_score", "shade_score", "obstruction_score")
        }
        avg_seg_pct = {
            cls: round(sum(p["segmentation_pct"].get(cls, 0.0) for p in activity_photo_scores) / n, 2)
            for cls in CITYSCAPES_CLASSES_OF_INTEREST
        }
        if avg_composite >= 66:
            avg_label = "Baik"
        elif avg_composite >= 40:
            avg_label = "Sedang"
        else:
            avg_label = "Buruk"

        activity_features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "activity_id": activity_id,
                "title": title,
                "description": description,
                "n_photos_analyzed": n,
                "composite_score": avg_composite,
                "label": avg_label,
                "components": avg_components,
                "segmentation_pct": avg_seg_pct,
            },
        })
        print(f"[{activity_id}] {title!r}: avg score={avg_composite} ({avg_label}) over {n} photos")

    photo_results_path = ANALYSIS_DIR / "photo_results.json"
    photo_results_path.write_text(json.dumps(photo_results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved {len(photo_results)} photo results to {photo_results_path}")

    activity_geojson = {"type": "FeatureCollection", "features": activity_features}
    activity_geojson_path = ANALYSIS_DIR / "activity_scores.geojson"
    activity_geojson_path.write_text(json.dumps(activity_geojson, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(activity_features)} activity summaries to {activity_geojson_path}")

    print("\n--- Sample activity scores ---")
    for feat in activity_features[:5]:
        p = feat["properties"]
        print(f"  {p['title']!r}: score={p['composite_score']} ({p['label']}) "
              f"sidewalk%={p['segmentation_pct']['sidewalk']} vegetation%={p['segmentation_pct']['vegetation']}")

    print("\nDone.")


if __name__ == "__main__":
    main()
