# Main — FastAPI app: health + Gemini chat proxy.

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

# Load .env from repo root or backend/ (first file found wins).
_ROOT = Path(__file__).resolve().parent.parent
for env_path in (_ROOT / ".env", Path(__file__).resolve().parent / ".env"):
    if env_path.is_file():
        load_dotenv(env_path)
        break
else:
    load_dotenv()

GEMINI_MODEL = "gemini-2.5-flash"


def _api_key() -> str:
    key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not key:
        raise HTTPException(
            status_code=500,
            detail="Missing GEMINI_API_KEY or GOOGLE_API_KEY in environment.",
        )
    return key


def _cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "http://localhost:3000")
    return [o.strip() for o in raw.split(",") if o.strip()]


def _system_instruction(locale: str) -> str:
    loc = (locale or "pt-PT").lower()
    if loc.startswith("pt"):
        return (
            "És um assistente de voz útil. Responde sempre em português europeu (pt-PT), "
            "com frases claras e naturais para serem lidas em voz alta. Mantém respostas concisas."
        )
    return (
        "You are a helpful voice assistant. Answer in clear, natural English suited for text-to-speech. "
        "Keep replies concise."
    )


app = FastAPI(title="agent-thats-speeks API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: str = Field(..., description="user or model")
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    locale: str = "pt-PT"


class ChatResponse(BaseModel):
    reply: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/chat", response_model=ChatResponse)
def chat(body: ChatRequest):
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")
    last = body.messages[-1]
    if last.role != "user":
        raise HTTPException(status_code=400, detail="last message must be from user")

    contents: list[types.Content] = []
    for m in body.messages:
        if m.role not in ("user", "model"):
            raise HTTPException(status_code=400, detail="role must be user or model")
        r = "user" if m.role == "user" else "model"
        contents.append(types.Content(role=r, parts=[types.Part(text=m.content)]))

    try:
        client = genai.Client(api_key=_api_key())
        cfg = types.GenerateContentConfig(
            system_instruction=_system_instruction(body.locale),
            temperature=0.7,
        )
        resp = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=cfg,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    text = (resp.text or "").strip()
    if not text:
        raise HTTPException(status_code=502, detail="Empty model response")
    return ChatResponse(reply=text)
