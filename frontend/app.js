"use strict";

// ── Configuration ──────────────────────────────────────────────────────────
const API_BASE = "http://localhost:8000";

const PROMPTS = [
  { emoji: "🏠", text: "Describe your hometown and what makes it special." },
  { emoji: "📅", text: "Walk me through a typical day in your life." },
  { emoji: "✈️",  text: "Talk about your most memorable travel experience." },
  { emoji: "🎯", text: "What are your career goals and why?" },
  { emoji: "📚", text: "Describe a book, film, or show you recently enjoyed." },
  { emoji: "🌍", text: "Discuss a current world issue you care about." },
];

const SCORE_LABELS = {
  pronunciation: "Pronunciation",
  fluency:       "Fluency",
  accuracy:      "Accuracy",
  grammar:       "Grammar",
  vocabulary:    "Vocabulary",
};

// ── State ──────────────────────────────────────────────────────────────────
let mediaRecorder  = null;
let audioChunks    = [];
let audioBlob      = null;
let uploadedFile   = null;
let timerInterval  = null;
let recordSeconds  = 0;
let animFrameId    = null;
let analyserNode   = null;
let radarChart     = null;
let activeTab      = "record";
let selectedPrompt = null;
let loadingStepIdx = 0;
let loadingInterval= null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const el = {
  promptGrid:    $("prompt-grid"),
  customPrompt:  $("custom-prompt"),
  tabRecord:     $("tab-record"),
  tabUpload:     $("tab-upload"),
  micContainer:  $("mic-container"),
  timer:         $("timer"),
  waveform:      $("waveform"),
  btnRecord:     $("btn-record"),
  btnStop:       $("btn-stop"),
  btnRerecord:   $("btn-rerecord"),
  audioPlayback: $("audio-playback"),
  dropzone:      $("dropzone"),
  fileInput:     $("file-input"),
  filePreview:   $("file-preview"),
  fileName:      $("file-name"),
  btnRemoveFile: $("btn-remove-file"),
  btnAssess:     $("btn-assess"),
  inputSection:  $("input-section"),
  loadingSection:$("loading-section"),
  resultsSection:$("results-section"),
  errorBanner:   $("error-banner"),
  errorText:     $("error-text"),
  btnDismissErr: $("btn-dismiss-error"),
  cefrBadge:     $("cefr-badge"),
  cefrLevel:     $("cefr-level"),
  cefrDesc:      $("cefr-desc"),
  ringFg:        $("ring-fg"),
  overallScore:  $("overall-score"),
  barList:       $("bar-list"),
  radarChart:    $("radar-chart"),
  transcriptText:$("transcript-text"),
  feedbackText:  $("feedback-text"),
  vocabWrap:     $("vocab-wrap"),
  wordsWrap:     $("words-wrap"),
  wordChips:     $("word-chips"),
  btnNew:        $("btn-new"),
};

// ── Prompt chips ───────────────────────────────────────────────────────────
PROMPTS.forEach(p => {
  const chip = document.createElement("button");
  chip.className = "prompt-chip";
  chip.textContent = `${p.emoji} ${p.text}`;
  chip.addEventListener("click", () => {
    document.querySelectorAll(".prompt-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    selectedPrompt = p.text;
    el.customPrompt.value = "";
  });
  el.promptGrid.appendChild(chip);
});

el.customPrompt.addEventListener("input", () => {
  document.querySelectorAll(".prompt-chip").forEach(c => c.classList.remove("active"));
  selectedPrompt = el.customPrompt.value.trim() || null;
});

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    activeTab = tab.dataset.tab;
    el.tabRecord.classList.toggle("hidden", activeTab !== "record");
    el.tabUpload.classList.toggle("hidden", activeTab !== "upload");
    refreshAssessBtn();
  });
});

// ── Recording ──────────────────────────────────────────────────────────────
const MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];
const getSupportedMime = () => MIME_TYPES.find(t => {
  try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
}) || "";

el.btnRecord.addEventListener("click", startRecording);
el.btnStop.addEventListener("click", stopRecording);
el.btnRerecord.addEventListener("click", resetRecorder);

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showError("Your browser does not support microphone access. Please use Chrome, Firefox, or Edge.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
    });

    audioChunks = [];
    audioBlob   = null;
    const mime  = getSupportedMime();
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = finaliseRecording;
    mediaRecorder.start(100);

    setupWaveform(stream);
    startTimer();

    el.micContainer.classList.add("recording");
    el.btnRecord.classList.add("hidden");
    el.btnStop.classList.remove("hidden");
    el.btnRerecord.classList.add("hidden");
    el.audioPlayback.classList.add("hidden");
    refreshAssessBtn();
  } catch (err) {
    showError(`Microphone access denied: ${err.message}`);
  }
}

function stopRecording() {
  if (mediaRecorder?.state !== "inactive") mediaRecorder.stop();
  mediaRecorder?.stream?.getTracks().forEach(t => t.stop());
  stopTimer();
  stopWaveform();
  el.micContainer.classList.remove("recording");
  el.btnStop.classList.add("hidden");
}

function finaliseRecording() {
  const mime = mediaRecorder?.mimeType || "audio/webm";
  audioBlob  = new Blob(audioChunks, { type: mime });
  el.audioPlayback.src = URL.createObjectURL(audioBlob);
  el.audioPlayback.classList.remove("hidden");
  el.btnRerecord.classList.remove("hidden");
  refreshAssessBtn();
}

function resetRecorder() {
  audioBlob  = null;
  audioChunks = [];
  stopTimer();
  stopWaveform();
  el.micContainer.classList.remove("recording");
  el.btnRecord.classList.remove("hidden");
  el.btnStop.classList.add("hidden");
  el.btnRerecord.classList.add("hidden");
  el.audioPlayback.classList.add("hidden");
  el.audioPlayback.src = "";
  clearWaveform();
  refreshAssessBtn();
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startTimer() {
  recordSeconds = 0;
  updateTimerDisplay();
  timerInterval = setInterval(() => { recordSeconds++; updateTimerDisplay(); }, 1000);
}
function stopTimer()  { clearInterval(timerInterval); timerInterval = null; }
function updateTimerDisplay() {
  const m = Math.floor(recordSeconds / 60);
  const s = recordSeconds % 60;
  el.timer.textContent = `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Waveform ───────────────────────────────────────────────────────────────
function setupWaveform(stream) {
  const ctx     = new AudioContext();
  const source  = ctx.createMediaStreamSource(stream);
  analyserNode  = ctx.createAnalyser();
  analyserNode.fftSize = 256;
  source.connect(analyserNode);
  drawWaveform();
}

function drawWaveform() {
  const canvas = el.waveform;
  const ctx    = canvas.getContext("2d");
  const data   = new Uint8Array(analyserNode?.frequencyBinCount || 128);

  const draw = () => {
    animFrameId = requestAnimationFrame(draw);
    analyserNode?.getByteFrequencyData(data);
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#222637";
    ctx.fillRect(0, 0, W, H);

    const barW   = W / data.length * 2.5;
    const gap    = 1;
    let x = 0;
    data.forEach(val => {
      const barH = (val / 255) * H;
      const alpha = 0.5 + (val / 255) * 0.5;
      ctx.fillStyle = `rgba(108,99,255,${alpha})`;
      ctx.fillRect(x, H - barH, barW, barH);
      x += barW + gap;
    });
  };
  draw();
}

function stopWaveform() {
  cancelAnimationFrame(animFrameId);
  animFrameId  = null;
  analyserNode = null;
}

function clearWaveform() {
  const canvas = el.waveform;
  const ctx    = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#222637";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  el.timer.textContent = "0:00";
}

// ── File upload ────────────────────────────────────────────────────────────
el.dropzone.addEventListener("click", () => el.fileInput.click());
el.dropzone.addEventListener("dragover",  e => { e.preventDefault(); el.dropzone.classList.add("drag-over"); });
el.dropzone.addEventListener("dragleave", ()  => el.dropzone.classList.remove("drag-over"));
el.dropzone.addEventListener("drop", e => {
  e.preventDefault();
  el.dropzone.classList.remove("drag-over");
  handleFile(e.dataTransfer.files[0]);
});
el.fileInput.addEventListener("change", () => handleFile(el.fileInput.files[0]));
el.btnRemoveFile.addEventListener("click", () => {
  uploadedFile = null;
  el.fileInput.value = "";
  el.filePreview.classList.add("hidden");
  el.dropzone.classList.remove("hidden");
  refreshAssessBtn();
});

function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith("audio/") && !/\.(wav|mp3|ogg|webm|m4a|flac|opus)$/i.test(file.name)) {
    showError("Please select an audio file (WAV, MP3, OGG, WebM, M4A, FLAC).");
    return;
  }
  const maxBytes = 25 * 1024 * 1024;
  if (file.size > maxBytes) {
    showError("File is too large. Maximum size is 25 MB.");
    return;
  }
  uploadedFile = file;
  el.fileName.textContent = file.name;
  el.dropzone.classList.add("hidden");
  el.filePreview.classList.remove("hidden");
  refreshAssessBtn();
}

// ── Assess button state ────────────────────────────────────────────────────
function refreshAssessBtn() {
  const hasAudio = (activeTab === "record" && audioBlob) || (activeTab === "upload" && uploadedFile);
  el.btnAssess.disabled = !hasAudio;
}

// ── Submit assessment ──────────────────────────────────────────────────────
el.btnAssess.addEventListener("click", submitAssessment);

async function submitAssessment() {
  const file  = activeTab === "record"
    ? new File([audioBlob], "recording.webm", { type: audioBlob.type })
    : uploadedFile;

  if (!file) return;

  const prompt = el.customPrompt.value.trim() || selectedPrompt || null;
  const form   = new FormData();
  form.append("audio", file);
  if (prompt) form.append("speaking_prompt", prompt);

  showLoading();
  startLoadingSteps();

  try {
    const res  = await fetch(`${API_BASE}/api/assess`, { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || `Server error ${res.status}`);
    stopLoadingSteps();
    renderResults(body);
  } catch (err) {
    stopLoadingSteps();
    hideLoading();
    showError(err.message);
  }
}

// ── Loading steps animation ────────────────────────────────────────────────
const STEP_IDS = ["step-1", "step-2", "step-3", "step-4"];

function showLoading() {
  el.inputSection.classList.add("hidden");
  el.loadingSection.classList.remove("hidden");
  el.resultsSection.classList.add("hidden");
  STEP_IDS.forEach(id => {
    const s = $(id);
    s.classList.remove("active", "done");
  });
  loadingStepIdx = 0;
  $(STEP_IDS[0]).classList.add("active");
}

function startLoadingSteps() {
  const delays = [3000, 5000, 3000];
  let idx = 0;
  loadingInterval = setInterval(() => {
    if (idx >= delays.length) return;
    $(STEP_IDS[idx]).classList.remove("active");
    $(STEP_IDS[idx]).classList.add("done");
    idx++;
    if (idx < STEP_IDS.length) $(STEP_IDS[idx]).classList.add("active");
  }, delays[idx] || 3000);
}

function stopLoadingSteps() {
  clearInterval(loadingInterval);
  STEP_IDS.forEach(id => { const s = $(id); s.classList.remove("active"); s.classList.add("done"); });
}

function hideLoading() {
  el.loadingSection.classList.add("hidden");
  el.inputSection.classList.remove("hidden");
}

// ── Results rendering ──────────────────────────────────────────────────────
function renderResults(data) {
  el.loadingSection.classList.add("hidden");
  el.resultsSection.classList.remove("hidden");

  // CEFR badge
  const lvl = data.cefr_level;
  el.cefrBadge.dataset.level = lvl;
  el.cefrLevel.textContent = lvl;
  // Short description: first 2 words
  el.cefrDesc.textContent  = data.cefr_description.split("—")[0].trim();

  // Score ring (circumference = 2π×50 ≈ 314)
  const circ   = 314;
  const offset = circ - (data.overall_score / 100) * circ;
  setTimeout(() => {
    el.ringFg.style.strokeDashoffset = offset;
    el.overallScore.textContent = Math.round(data.overall_score);
  }, 100);

  // Component bars
  el.barList.innerHTML = "";
  Object.entries(SCORE_LABELS).forEach(([key, label]) => {
    const val = data.scores[key] ?? 0;
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span class="bar-label">${label}</span>
      <div class="bar-track"><div class="bar-fill" data-val="${val}"></div></div>
      <span class="bar-val">${Math.round(val)}</span>`;
    el.barList.appendChild(row);
  });
  setTimeout(() => {
    document.querySelectorAll(".bar-fill").forEach(bar => {
      bar.style.width = `${bar.dataset.val}%`;
    });
  }, 150);

  // Radar chart
  renderRadar(data.scores);

  // Transcript
  el.transcriptText.textContent = data.transcript;

  // Feedback
  el.feedbackText.textContent = data.feedback;

  // Vocabulary note
  if (data.vocabulary_description) {
    el.vocabWrap.innerHTML = `
      <h3>Vocabulary</h3>
      <p class="vocab-note">${escHtml(data.vocabulary_description)}</p>`;
  }

  // Grammar strengths / issues
  const grammarItems = [];
  if (data.grammar_strengths?.length) {
    data.grammar_strengths.forEach(s => grammarItems.push(`<li class="strength">✓ ${escHtml(s)}</li>`));
  }
  if (data.grammar_issues?.length) {
    data.grammar_issues.forEach(i => grammarItems.push(`<li class="issue">✗ ${escHtml(i)}</li>`));
  }
  if (grammarItems.length) {
    el.vocabWrap.innerHTML += `
      <h3 style="margin-top:1rem">Grammar Notes</h3>
      <ul style="padding-left:1.25rem;font-size:.875rem;line-height:2;color:var(--muted)">
        ${grammarItems.join("")}
      </ul>`;
  }

  // Word-level pronunciation errors
  const badWords = (data.word_details || []).filter(w => w.error_type && w.error_type !== "None");
  if (badWords.length) {
    el.wordsWrap.classList.remove("hidden");
    el.wordChips.innerHTML = badWords.map(w => {
      const cls = w.error_type.toLowerCase().replace(/\s+/g, "-");
      return `<span class="word-chip ${cls}" title="${escHtml(w.error_type)}">${escHtml(w.word)}</span>`;
    }).join("");
  } else {
    el.wordsWrap.classList.add("hidden");
  }

  // Scroll to results
  el.resultsSection.scrollIntoView({ behavior: "smooth" });
}

// ── Radar chart ────────────────────────────────────────────────────────────
function renderRadar(scores) {
  if (radarChart) radarChart.destroy();
  const labels = Object.values(SCORE_LABELS);
  const values = Object.keys(SCORE_LABELS).map(k => Math.round(scores[k] ?? 0));

  radarChart = new Chart(el.radarChart, {
    type: "radar",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor:   "rgba(108,99,255,.2)",
        borderColor:       "rgba(108,99,255,.8)",
        pointBackgroundColor: "rgba(108,99,255,1)",
        pointBorderColor:  "#fff",
        pointRadius:       4,
        borderWidth:       2,
      }],
    },
    options: {
      animation: { duration: 800 },
      scales: {
        r: {
          min: 0, max: 100, stepSize: 25,
          grid:      { color: "rgba(255,255,255,.08)" },
          angleLines:{ color: "rgba(255,255,255,.08)" },
          pointLabels: { color: "#8890a8", font: { size: 11 } },
          ticks: { color: "#8890a8", backdropColor: "transparent", stepSize: 25 },
        },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// ── New assessment ─────────────────────────────────────────────────────────
el.btnNew.addEventListener("click", () => {
  el.resultsSection.classList.add("hidden");
  el.inputSection.classList.remove("hidden");
  resetRecorder();
  uploadedFile = null;
  el.fileInput.value = "";
  el.filePreview.classList.add("hidden");
  el.dropzone.classList.remove("hidden");
  refreshAssessBtn();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ── Error banner ───────────────────────────────────────────────────────────
function showError(msg) {
  el.errorText.textContent = msg;
  el.errorBanner.classList.remove("hidden");
  setTimeout(() => el.errorBanner.classList.add("hidden"), 8000);
}
el.btnDismissErr.addEventListener("click", () => el.errorBanner.classList.add("hidden"));

// ── Utility ────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Init ───────────────────────────────────────────────────────────────────
clearWaveform();
