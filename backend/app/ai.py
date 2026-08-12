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


async def insight(use_case: str, audience: str, summary: dict) -> str:
    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": f"{SYSTEM} {AUDIENCE[audience]}"},
            {"role": "user", "content": f"Use case: {use_case}\nHasil analisis:\n{json.dumps(summary, ensure_ascii=False)}"},
        ],
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(GROQ_URL, headers={"Authorization": f"Bearer {GROQ_API_KEY}"}, json=payload)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]
