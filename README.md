# English Proficiency Assessment

CEFR-level English assessment (A1–C2) using **Azure Speech Service** for pronunciation/fluency
and **Anthropic Claude** for grammar/vocabulary analysis.

---

## Architecture

```
Browser (record / upload audio)
       │
       ▼  multipart/form-data
FastAPI backend (port 8000)
       ├─► Azure Speech Service  → pronunciation, fluency, accuracy scores
       └─► Anthropic Claude API  → grammar, vocabulary scores + feedback
       │
       ▼  JSON
Browser renders CEFR badge, score ring, radar chart, feedback
```

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Python | 3.10 + | |
| pip | latest | `python -m pip install --upgrade pip` |
| ffmpeg | any | Required by pydub for audio conversion |

### Install ffmpeg

**Windows**
```
winget install Gyan.FFmpeg
# or download from https://ffmpeg.org/download.html and add to PATH
```

**macOS**
```
brew install ffmpeg
```

**Linux (Debian/Ubuntu)**
```
sudo apt-get install ffmpeg
```

---

## Step 1 — Azure Speech Service

1. Sign in to [portal.azure.com](https://portal.azure.com)
2. **Create resource** → search **"Speech"** → select **Speech** (Microsoft)
3. Region: choose the region closest to your users (e.g. `eastus`)
4. Pricing tier: **Free (F0)** for development (5 audio hours/month free)
5. After deployment, go to **Keys and Endpoint**
6. Copy **KEY 1** and your **Location/Region**

> Pronunciation Assessment is included in all Speech tiers.
> For C1/C2 accuracy, the **eastus** and **westeurope** regions give the best models.

---

## Step 2 — Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. **API Keys** → **Create Key**
3. Copy the key (shown only once)

---

## Step 3 — Backend Setup

```bash
cd english-assessment/backend

# Copy and fill in your credentials
cp .env.example .env
# Edit .env with your Azure and Anthropic keys

# Create virtual environment
python -m venv venv
source venv/bin/activate        # macOS/Linux
venv\Scripts\activate           # Windows PowerShell

# Install dependencies
pip install -r requirements.txt

# Start the server
python main.py
# → Running at http://localhost:8000
```

The API docs (Swagger UI) are available at **http://localhost:8000/docs**.

### Health check

```bash
curl http://localhost:8000/health
# {"status":"ok"}  ← both credentials found
# {"status":"degraded","missing_env_vars":["AZURE_SPEECH_KEY"]}  ← missing creds
```

---

## Step 4 — Frontend

Open `frontend/index.html` directly in your browser, **or** serve it:

```bash
# Python quick server
python -m http.server 3000 --directory frontend
# → http://localhost:3000
```

Then update **CORS** in `.env`:
```
ALLOWED_ORIGINS=http://localhost:3000
```

---

## Integrating into an Existing Website

### Option A — Embed as iframe

```html
<iframe
  src="https://your-assessment-domain.com"
  width="100%" height="900"
  frameborder="0"
  allow="microphone">
</iframe>
```

### Option B — Call the API directly from your frontend

```javascript
const form = new FormData();
form.append("audio", audioBlob, "recording.webm");
form.append("speaking_prompt", "Describe your hometown.");

const res  = await fetch("https://your-api-domain.com/api/assess", {
  method: "POST",
  body: form,
});
const data = await res.json();
/*
{
  cefr_level: "B2",
  cefr_description: "Upper Intermediate — independent user of complex language",
  overall_score: 67.4,
  scores: {
    pronunciation: 71.2,
    fluency: 68.5,
    accuracy: 69.0,
    grammar: 65.0,
    vocabulary: 62.0
  },
  transcript: "...",
  feedback: "...",
  grammar_issues: [...],
  grammar_strengths: [...],
  vocabulary_description: "...",
  word_details: [...]
}
*/
```

---

## Deploying to Production

### Backend (Python)

```bash
# Gunicorn + uvicorn workers
pip install gunicorn
gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

Set environment variables on your host (never commit `.env` to git):

```
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastus
ANTHROPIC_API_KEY=...
ALLOWED_ORIGINS=https://yourwebsite.com
MAX_FILE_MB=25
```

### Frontend

Upload the `frontend/` folder to any static host (Netlify, Vercel, S3, etc.)
and point `API_BASE` in `app.js` to your deployed API URL.

---

## CEFR Scoring Method

| Component | Source | Weight |
|-----------|--------|--------|
| Fluency | Azure Speech Pronunciation Assessment | 25 % |
| Pronunciation | Azure Speech Pronunciation Assessment | 20 % |
| Accuracy | Azure Speech Pronunciation Assessment | 20 % |
| Grammar | Claude AI analysis of transcript | 20 % |
| Vocabulary | Claude AI analysis of transcript | 15 % |

| Score range | CEFR level |
|-------------|------------|
| 87 – 100 | C2 Mastery |
| 75 – 86 | C1 Advanced |
| 62 – 74 | B2 Upper Intermediate |
| 50 – 61 | B1 Intermediate |
| 37 – 49 | A2 Elementary |
| 0 – 36 | A1 Beginner |

---

## Audio Requirements

| Format | Notes |
|--------|-------|
| WAV | Best — no conversion needed |
| MP3 | Fully supported |
| WebM / OGG | Browser-recorded audio (Chrome, Firefox) |
| M4A / MP4 | Safari / iOS recordings |
| FLAC | Lossless, ideal for long recordings |

Recommended: **30–120 seconds** of continuous speech on one topic.
Minimum: 5 words recognised (≈ 5 seconds).

---

## File Structure

```
english-assessment/
├── backend/
│   ├── main.py           ← FastAPI app (assessment logic)
│   ├── requirements.txt
│   └── .env.example      ← copy to .env and fill in keys
└── frontend/
    ├── index.html        ← single-page UI
    ├── styles.css
    └── app.js            ← recording, upload, API calls, results rendering
```
