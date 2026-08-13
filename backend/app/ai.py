"""Groq (free tier) narrative layer. The key never leaves the backend."""

import json

import httpx

from .config import GROQ_API_KEY, GROQ_MODEL

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

SYSTEM = (
    "Kamu analis perencanaan kota untuk SuperMaps, WebGIS kawasan transit Jabodetabek. "
    "Kamu menerima hasil analisis spasial dalam JSON. Jelaskan artinya untuk pembaca awam "
    "dalam Bahasa Indonesia, maksimal 6 kalimat, lalu beri 3 rekomendasi tindakan yang konkret. "
    "Hanya gunakan angka yang ada di JSON. Jangan mengarang data."
)

AUDIENCE = {
    "komuter": "Pembaca adalah komuter harian.",
    "usaha": "Pembaca adalah pelaku usaha yang mencari lokasi.",
    "kebijakan": "Pembaca adalah pemangku kebijakan pengembangan kawasan.",
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


async def _complete(messages: list[dict], json_mode: bool = False) -> str:
    payload = {"model": GROQ_MODEL, "messages": messages, "temperature": 0.2}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(GROQ_URL, headers={"Authorization": f"Bearer {GROQ_API_KEY}"}, json=payload)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


async def insight(use_case: str, audience: str, summary: dict) -> str:
    return await _complete([
        {"role": "system", "content": f"{SYSTEM} {AUDIENCE[audience]}"},
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
