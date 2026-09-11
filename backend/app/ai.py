"""Groq (free tier) narrative layer. The key never leaves the backend."""

import json

import httpx

from .config import GROQ_API_KEY, GROQ_MODEL

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# User-selectable in AiPanel - "smart" (better reasoning, tighter free-tier rate limit)
# vs "fast" (fallback when smart gets rate-limited).
MODELS = {"smart": "openai/gpt-oss-120b", "fast": "openai/gpt-oss-20b"}


class GroqRateLimited(Exception):
    """Groq returned 429 - distinct from other failures so the API can tell the
    frontend specifically "switch model", not just a generic error."""

SYSTEM = (
    "Kamu analis perencanaan kota untuk SuperMaps, WebGIS kawasan transit Jabodetabek. Kamu "
    "menerima hasil analisis spasial dalam JSON untuk use case \"{use_case}\". Tugasmu BUKAN "
    "membacakan ulang angka mentah - jelaskan artinya secara bisnis/praktis: apa dampaknya buat "
    "{audience_desc}, keputusan apa yang sebaiknya diambil, dan kenapa ini penting bagi mereka "
    "sekarang. {audience_frame} Gunakan angka dari JSON hanya sebagai bukti pendukung argumenmu, "
    "jangan jadikan angka itu sendiri sebagai keseluruhan jawaban. Tulis dalam Bahasa Indonesia "
    "untuk pembaca awam, maksimal 6 kalimat, lalu beri 3 rekomendasi tindakan yang konkret dan "
    "bisa langsung dieksekusi. Hanya gunakan angka yang benar-benar ada di JSON - jangan mengarang "
    "data atau angka yang tidak ada di sana."
)

AUDIENCE = {
    "komuter": {
        "desc": "komuter harian",
        "frame": "Fokuskan penjelasan pada pengalaman perjalanan sehari-hari mereka - apakah "
                 "rute ini nyaman/aman/cepat dipakai, dan apa yang perlu mereka antisipasi.",
    },
    "usaha": {
        "desc": "pelaku usaha yang mencari lokasi",
        "frame": "Fokuskan penjelasan pada kelayakan bisnis - potensi permintaan, tingkat "
                 "persaingan, risiko operasional, dan apakah lokasi ini layak dipertimbangkan "
                 "atau justru sebaiknya dihindari.",
    },
    "kebijakan": {
        "desc": "pemangku kebijakan pengembangan kawasan",
        "frame": "Fokuskan penjelasan pada implikasi perencanaan - prioritas intervensi mana "
                 "yang paling mendesak, trade-off yang perlu dipertimbangkan, dan dampaknya "
                 "bagi warga/kawasan kalau dibiarkan atau ditangani.",
    },
}


CHAT_SYSTEM = """Kamu asisten analis SuperMaps untuk Indeks TOD (SCI) kawasan transit Jabodetabek.

Kamu menerima tabel seluruh stasiun berisi: station, station_id, mode_label (KRL/MRT/LRT/TJ),
sci, rank, classification (tinggi/sedang/rendah), typology, typology_reason, criteria (8 kriteria),
indicators (18 indikator), priorities (indikator terlemah beserta potential_gain), impact, benefit,
dan quadrant.

Aturan:
- Jawab dalam Bahasa Indonesia, ringkas, maksimal 8 kalimat. Sebut angka konkret dari tabel.
- Hanya gunakan angka yang ada di tabel. Jangan mengarang data atau nama stasiun.
- Indikator dengan source PROXY atau CONSTANT bukan data terukur. Kalau jawabanmu bertumpu pada
  indikator itu, sebutkan bahwa angkanya proksi.
- Untuk pertanyaan "kalau X diperbaiki naik berapa", sebut indikator yang dimaksud lalu arahkan
  pengguna memakai simulasi what-if di panel Detail. Jangan menebak angka kenaikannya sendiri.

Balas HANYA JSON valid dengan bentuk:
{"answer": "...", "filters": {"modes": [], "classifications": [], "typologies": []}, "focus_station": null}

filters memfilter peta. Isi hanya kalau pengguna memang meminta penyaringan, selain itu biarkan
array kosong. focus_station diisi station_id kalau pertanyaan menyorot satu stasiun."""


async def _complete(messages: list[dict], json_mode: bool = False, model: str | None = None) -> str:
    payload = {"model": model or GROQ_MODEL, "messages": messages, "temperature": 0.2}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(GROQ_URL, headers={"Authorization": f"Bearer {GROQ_API_KEY}"}, json=payload)
        if r.status_code == 429:
            raise GroqRateLimited(f"model {payload['model']} sedang rate-limited")
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


async def insight(use_case: str, audience: str, summary: dict) -> str:
    aud = AUDIENCE[audience]
    system = SYSTEM.format(use_case=use_case, audience_desc=aud["desc"], audience_frame=aud["frame"])
    return await _complete([
        {"role": "system", "content": system},
        {"role": "user", "content": f"Use case: {use_case}\nHasil analisis:\n{json.dumps(summary, ensure_ascii=False)}"},
    ])


def _compact(rows: list[dict]) -> list[dict]:
    """Trim the dashboard to what the model needs, so the whole table fits in the prompt."""
    return [
        {
            "station": r["station"], "station_id": r["station_id"], "mode_label": r["mode_label"],
            "sci": r["sci"], "rank": r["rank"], "classification": r["classification"],
            "typology": r["typology"], "typology_reason": r["typology_reason"],
            "criteria": r["criteria"], "indicators": r["indicators"],
            "impact": r["impact"], "benefit": r["benefit"], "quadrant": r["quadrant"],
            "priorities": [
                {"label": p["label"], "score": p["score"], "source": p["source"],
                 "potential_gain": p["potential_gain"]}
                for p in r["priorities"][:5]
            ],
        }
        for r in rows
    ]


async def chat(messages: list[dict], rows: list[dict]) -> dict:
    table = json.dumps(_compact(rows), ensure_ascii=False)
    text = await _complete(
        [{"role": "system", "content": f"{CHAT_SYSTEM}\n\nTabel stasiun:\n{table}"}] + messages,
        json_mode=True,
    )
    return json.loads(text)


# --- Q&A over an already-run result, uniform across every use case -----------
# One system prompt for all five use cases - the model infers what fields exist from
# the JSON keys it's given each call (they differ naturally per use case) instead of
# a hardcoded per-use-case blurb to keep in sync by hand.
ASK_SYSTEM = (
    "Kamu konsultan SuperMaps, WebGIS kawasan transit Jabodetabek. Pengguna sedang melihat "
    "\"{label}\". Kamu menerima hasil analisis spasial use case ini dalam JSON (geometri sudah "
    "dihapus, tinggal properti) - field yang ada beda-beda tergantung use case, baca langsung "
    "dari JSON-nya, jangan asumsikan struktur tetap.\n\n"
    "Pengguna boleh menanyakan apa saja seputar konteks ini - bukan cuma \"jelaskan angka grid "
    "ini\", tapi juga pertanyaan bisnis/praktis: kelayakan buka usaha, risiko, prioritas, "
    "perbandingan lokasi, strategi, dsb. Jawab dengan penalaran konsultan sungguhan: gabungkan "
    "angka dari JSON dengan pengetahuan umum kamu (prinsip bisnis, tata kota, mitigasi risiko, "
    "dll) untuk kasih jawaban yang berguna dan actionable, bukan cuma membacakan angka.\n\n"
    "Aturan integritas data (bukan pembatas topik): setiap ANGKA yang kamu sebut harus benar-"
    "benar ada di JSON - jangan mengarang angka atau skor gabungan yang tidak ada (proyek ini "
    "sengaja tidak punya skor \"suitability\"/\"vulnerability\" gabungan - tampilkan komponennya "
    "terpisah). Tapi penalaran, opini, rekomendasi, dan pengetahuan umum di luar JSON itu boleh "
    "dan diharapkan, selama kamu jelas mana yang \"dari data\" dan mana yang \"opini/pengetahuan "
    "umum\". Kalau JSON tidak punya data yang relevan buat menjawab, tetap boleh kasih pandangan "
    "umum, tapi bilang terus terang bagian itu bukan dari data proyek ini.\n\n"
    "Jawab dalam Bahasa Indonesia, natural seperti konsultan ngobrol, tidak perlu template kaku."
)


MAX_PROMPT_CHARS = 8000  # Groq free tier rejects (413) large request bodies well before
# any model's real context limit - this is a request-size budget, not a token budget.


def _compact_result(result: dict) -> dict:
    """Drop geometry, keep properties/summary - geometries are huge and the model only
    ever needs to reason about the numbers/labels, never the coordinates.

    Does NOT cap how many features survive per FeatureCollection - a fixed cap silently
    truncated every grid layer to its first N cells (e.g. 12), so the model only ever saw
    a partial grid and had no way to know cells beyond that existed. That read as the
    model being wrong about a cell (e.g. "grid 38 doesn't exist") when the real bug was
    upstream. `_budget()` below is the actual size safety net - it drops an entire
    oversized key rather than serving a silently-partial, misleading one."""
    def strip(v):
        if isinstance(v, dict) and v.get("type") == "FeatureCollection":
            return [f.get("properties", {}) for f in v["features"]]
        return v
    return {k: strip(v) for k, v in result.items()}


def _budget(compact: dict) -> str:
    """Hard ceiling on the final JSON string regardless of how many keys/rows survived
    _compact_result - summary first (small, most important), other keys added only while
    the whole thing still serializes under budget, so a result with many large sections
    can't blow the request size.

    A key whose full value doesn't fit is no longer dropped outright if that value is a
    list (e.g. K-UC1's per-station rows) - it's trimmed down to however many leading
    elements DO fit instead. Sending 25 of 30 stations is still an answerable comparison;
    silently sending none of them (what used to happen the moment the 30th row tipped the
    JSON over budget) isn't, and reads as a data/AI bug rather than a size constraint."""
    summary = compact.pop("summary", None)
    out = {"summary": summary} if summary is not None else {}
    for k, v in compact.items():
        candidate = {**out, k: v}
        if len(json.dumps(candidate, ensure_ascii=False)) <= MAX_PROMPT_CHARS:
            out = candidate
            continue
        if not isinstance(v, list) or not v:
            continue
        lo, hi = 0, len(v)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            trial = {**out, k: v[:mid]}
            if len(json.dumps(trial, ensure_ascii=False)) <= MAX_PROMPT_CHARS:
                lo = mid
            else:
                hi = mid - 1
        if lo > 0:
            out = {**out, k: v[:lo]}
    return json.dumps(out, ensure_ascii=False)


async def ask(use_case_id: str, label: str, messages: list[dict], result: dict, model: str = "smart") -> str:
    system = ASK_SYSTEM.format(label=label)
    compact = _budget(_compact_result(result))
    return await _complete(
        [{"role": "system", "content": f"{system}\n\nHasil analisis:\n{compact}"}] + messages,
        model=MODELS.get(model, MODELS["smart"]),
    )
