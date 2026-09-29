"""
English Proficiency Assessment API
Combines Azure Speech Service (pronunciation/fluency) with Claude AI (grammar/vocabulary)
to produce CEFR-level scores (A1–C2).
"""

import os
import json
import re
import logging
import tempfile
import threading
from pathlib import Path
from typing import Optional

import azure.cognitiveservices.speech as speechsdk
import anthropic
from fastapi import FastAPI, File, UploadFile, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pydub import AudioSegment
import uvicorn
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

AZURE_SPEECH_KEY    = os.getenv("AZURE_SPEECH_KEY", "")
AZURE_SPEECH_REGION = os.getenv("AZURE_SPEECH_REGION", "eastus")
ANTHROPIC_API_KEY   = os.getenv("ANTHROPIC_API_KEY", "")
ALLOWED_ORIGINS     = os.getenv("ALLOWED_ORIGINS", "*").split(",")

MAX_FILE_MB  = int(os.getenv("MAX_FILE_MB", "25"))
MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024

CEFR_THRESHOLDS = [
    (87, "C2", "Mastery — near-native proficiency with precision and ease"),
    (75, "C1", "Advanced — effective professional proficiency"),
    (62, "B2", "Upper Intermediate — independent user of complex language"),
    (50, "B1", "Intermediate — threshold communicator on familiar topics"),
    (37, "A2", "Elementary — basic communication in routine situations"),
    ( 0, "A1", "Beginner — isolated words and very simple phrases"),
]

SCORE_WEIGHTS = {
    "fluency":       0.25,
    "pronunciation": 0.20,
    "accuracy":      0.20,
    "grammar":       0.20,
    "vocabulary":    0.15,
}

# ── Models ────────────────────────────────────────────────────────────────────

class ComponentScores(BaseModel):
    pronunciation: float
    fluency: float
    accuracy: float
    grammar: float
    vocabulary: float

class WordDetail(BaseModel):
    word: str
    accuracy_score: float
    error_type: str

class AssessmentResult(BaseModel):
    cefr_level: str
    cefr_description: str
    overall_score: float
    scores: ComponentScores
    transcript: str
    feedback: str
    grammar_issues: list[str]
    grammar_strengths: list[str]
    vocabulary_description: str
    word_details: list[WordDetail]
    speaking_prompt: Optional[str] = None

# ── Audio helpers ─────────────────────────────────────────────────────────────

SUPPORTED_FORMATS = {".wav", ".mp3", ".ogg", ".webm", ".mp4", ".m4a", ".flac", ".opus"}

def convert_to_wav(src_path: str, dst_path: str) -> None:
    """Normalise any audio to 16 kHz mono 16-bit PCM WAV for Azure SDK."""
    audio = AudioSegment.from_file(src_path)
    audio = audio.set_channels(1).set_frame_rate(16000).set_sample_width(2)
    audio.export(dst_path, format="wav")

# ── Azure pronunciation assessment ───────────────────────────────────────────

def run_pronunciation_assessment(wav_path: str) -> dict:
    """
    Continuous-recognition pronunciation assessment.
    Returns averaged scores across all utterances plus per-word detail.
    """
    speech_config = speechsdk.SpeechConfig(
        subscription=AZURE_SPEECH_KEY, region=AZURE_SPEECH_REGION
    )
    speech_config.speech_recognition_language = "en-US"

    pa_config = speechsdk.PronunciationAssessmentConfig(
        grading_system=speechsdk.PronunciationAssessmentGradingSystem.HundredMark,
        granularity=speechsdk.PronunciationAssessmentGranularity.Word,
        enable_miscue=True,
    )
    try:
        pa_config.enable_prosody_assessment()
    except AttributeError:
        pass  # older SDK versions may not have this

    audio_config = speechsdk.AudioConfig(filename=wav_path)
    recognizer = speechsdk.SpeechRecognizer(
        speech_config=speech_config, audio_config=audio_config
    )
    pa_config.apply_to(recognizer)

    done = threading.Event()
    utterances: list[dict] = []
    all_words: list[dict] = []

    def on_recognized(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech:
            r = speechsdk.PronunciationAssessmentResult(evt.result)
            utterances.append({
                "text":              evt.result.text,
                "accuracy_score":    r.accuracy_score,
                "fluency_score":     r.fluency_score,
                "completeness_score": r.completeness_score,
                "pronunciation_score": r.pronunciation_score,
            })
            for w in r.words:
                all_words.append({
                    "word":           w.word,
                    "accuracy_score": w.accuracy_score,
                    "error_type":     w.error_type,
                })

    def on_stop(_evt):
        done.set()

    recognizer.recognized.connect(on_recognized)
    recognizer.session_stopped.connect(on_stop)
    recognizer.canceled.connect(on_stop)

    recognizer.start_continuous_recognition_async()
    done.wait(timeout=300)
    recognizer.stop_continuous_recognition_async().get()

    if not utterances:
        return {"success": False, "error": "No speech recognised — please speak clearly into the microphone."}

    n = len(utterances)
    return {
        "success": True,
        "transcript":          " ".join(u["text"] for u in utterances),
        "accuracy_score":      sum(u["accuracy_score"]    for u in utterances) / n,
        "fluency_score":       sum(u["fluency_score"]     for u in utterances) / n,
        "completeness_score":  sum(u["completeness_score"] for u in utterances) / n,
        "pronunciation_score": sum(u["pronunciation_score"] for u in utterances) / n,
        "words":               all_words[:30],
    }

# ── Claude grammar / vocabulary analysis ─────────────────────────────────────

_GRAMMAR_VOCAB_PROMPT = """You are a certified IELTS/CEFR examiner. Analyse this English speech transcript for grammar and vocabulary.

TRANSCRIPT:
"{transcript}"

Return ONLY valid JSON (no markdown fences) in this exact schema:
{{
  "grammar_score": <integer 0-100>,
  "vocabulary_score": <integer 0-100>,
  "grammar_issues": ["<concise issue>", ...],
  "grammar_strengths": ["<concise strength>", ...],
  "vocabulary_description": "<2-sentence description of vocabulary range and sophistication>",
  "specific_feedback": "<2-3 sentences of personalised, encouraging feedback>"
}}

Scoring guide (grammar_score):
- 0-36  A1: mostly isolated words/memorised phrases, many basic errors
- 37-49 A2: simple sentences, frequent errors with complex structures
- 50-61 B1: generally clear but noticeable errors with tenses, articles, prepositions
- 62-74 B2: good control with occasional non-systematic errors
- 75-86 C1: high accuracy, rare but notable errors
- 87-100 C2: near-native mastery, only occasional slips

Apply the same scale to vocabulary_score (range, precision, collocations, idioms)."""


def analyse_grammar_vocabulary(transcript: str, client: anthropic.Anthropic) -> dict:
    prompt = _GRAMMAR_VOCAB_PROMPT.format(transcript=transcript)
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=800,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = msg.content[0].text.strip()
    # Strip any accidental markdown code fences
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Claude grammar response was not valid JSON: %s", raw[:200])
        return {
            "grammar_score": 50,
            "vocabulary_score": 50,
            "grammar_issues": [],
            "grammar_strengths": [],
            "vocabulary_description": "Analysis temporarily unavailable.",
            "specific_feedback": raw[:400],
        }

# ── CEFR calculation ──────────────────────────────────────────────────────────

def calculate_cefr(scores: dict) -> tuple[str, float, str]:
    """Return (cefr_level, overall_score_0_100, description)."""
    overall = sum(scores[k] * w for k, w in SCORE_WEIGHTS.items())
    for threshold, level, desc in CEFR_THRESHOLDS:
        if overall >= threshold:
            return level, round(overall, 1), desc
    return "A1", round(overall, 1), CEFR_THRESHOLDS[-1][2]

# ── Feedback generation ───────────────────────────────────────────────────────

_FEEDBACK_PROMPT = """You are a supportive English language coach. The learner just completed a spoken assessment.

Assessment results:
- CEFR level: {cefr} ({cefr_desc})
- Pronunciation: {pronunciation}/100
- Fluency: {fluency}/100
- Accuracy: {accuracy}/100
- Grammar: {grammar}/100
- Vocabulary: {vocabulary}/100
- Grammar issues noted: {issues}
- Grammar strengths noted: {strengths}

Write 4–5 sentences of warm, specific, actionable feedback:
1. Acknowledge their current level positively.
2. Highlight their strongest skill.
3. Name one concrete area to improve with a practical tip.
4. Encourage them towards the next CEFR level."""


def generate_feedback(data: dict, client: anthropic.Anthropic) -> str:
    prompt = _FEEDBACK_PROMPT.format(**data)
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=350,
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.content[0].text.strip()

# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(title="English Proficiency Assessment API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

# Serve frontend from /static (optional — for local dev)
_frontend = Path(__file__).parent.parent / "frontend"
if _frontend.exists():
    app.mount("/static", StaticFiles(directory=str(_frontend), html=True), name="static")


@app.get("/health")
async def health():
    missing = [k for k, v in {
        "AZURE_SPEECH_KEY": AZURE_SPEECH_KEY,
        "ANTHROPIC_API_KEY": ANTHROPIC_API_KEY,
    }.items() if not v]
    if missing:
        return JSONResponse(
            {"status": "degraded", "missing_env_vars": missing}, status_code=503
        )
    return {"status": "ok"}


@app.post("/api/assess", response_model=AssessmentResult)
async def assess(
    audio: UploadFile = File(..., description="Audio file (WAV/MP3/WebM/OGG/M4A/FLAC)"),
    speaking_prompt: Optional[str] = None,
):
    # ── Validate credentials ──────────────────────────────────────────────────
    if not AZURE_SPEECH_KEY:
        raise HTTPException(500, "AZURE_SPEECH_KEY is not set on the server.")
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY is not set on the server.")

    # ── Validate file ─────────────────────────────────────────────────────────
    content = await audio.read()
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(413, f"File too large. Maximum is {MAX_FILE_MB} MB.")
    if len(content) < 1000:
        raise HTTPException(422, "Audio file is too short or empty.")

    suffix = Path(audio.filename or "audio.webm").suffix.lower() or ".webm"
    if suffix not in SUPPORTED_FORMATS:
        raise HTTPException(415, f"Unsupported format '{suffix}'. Use: {', '.join(SUPPORTED_FORMATS)}")

    # ── Save, convert, assess ─────────────────────────────────────────────────
    raw_tmp  = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    wav_tmp  = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    raw_path = raw_tmp.name
    wav_path = wav_tmp.name
    raw_tmp.close()
    wav_tmp.close()

    try:
        with open(raw_path, "wb") as f:
            f.write(content)

        log.info("Converting audio %s → WAV", suffix)
        try:
            convert_to_wav(raw_path, wav_path)
        except Exception as e:
            raise HTTPException(422, f"Audio conversion failed: {e}. Ensure ffmpeg is installed.")

        # Step 1 — Azure pronunciation
        log.info("Running Azure pronunciation assessment")
        pa = run_pronunciation_assessment(wav_path)
        if not pa["success"]:
            raise HTTPException(422, pa.get("error", "Pronunciation assessment failed."))

        transcript = pa["transcript"].strip()
        if len(transcript.split()) < 5:
            raise HTTPException(422, "Too few words recognised. Please speak for at least 20–30 seconds.")

        # Step 2 — Claude grammar / vocabulary
        log.info("Running Claude grammar/vocabulary analysis on %d words", len(transcript.split()))
        anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        gv = analyse_grammar_vocabulary(transcript, anthropic_client)

        # Step 3 — CEFR
        component_scores = {
            "pronunciation": pa["pronunciation_score"],
            "fluency":       pa["fluency_score"],
            "accuracy":      pa["accuracy_score"],
            "grammar":       gv["grammar_score"],
            "vocabulary":    gv["vocabulary_score"],
        }
        cefr_level, overall, cefr_desc = calculate_cefr(component_scores)
        log.info("Assessment complete: %s (%.1f)", cefr_level, overall)

        # Step 4 — Personalised feedback
        feedback = generate_feedback({
            "cefr":          cefr_level,
            "cefr_desc":     cefr_desc,
            "pronunciation": round(component_scores["pronunciation"], 1),
            "fluency":       round(component_scores["fluency"], 1),
            "accuracy":      round(component_scores["accuracy"], 1),
            "grammar":       round(component_scores["grammar"], 1),
            "vocabulary":    round(component_scores["vocabulary"], 1),
            "issues":        ", ".join(gv.get("grammar_issues", [])[:3]) or "none noted",
            "strengths":     ", ".join(gv.get("grammar_strengths", [])[:2]) or "none noted",
        }, anthropic_client)

        return AssessmentResult(
            cefr_level=cefr_level,
            cefr_description=cefr_desc,
            overall_score=overall,
            scores=ComponentScores(**{k: round(v, 1) for k, v in component_scores.items()}),
            transcript=transcript,
            feedback=feedback,
            grammar_issues=gv.get("grammar_issues", []),
            grammar_strengths=gv.get("grammar_strengths", []),
            vocabulary_description=gv.get("vocabulary_description", ""),
            word_details=[
                WordDetail(**w) for w in pa.get("words", [])
                if w.get("error_type", "None") != "None"
            ][:15],
            speaking_prompt=speaking_prompt,
        )

    finally:
        for p in (raw_path, wav_path):
            try:
                os.unlink(p)
            except OSError:
                pass


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
