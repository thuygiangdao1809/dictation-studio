import { storage } from "./storage.js";
import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";

const SK_LESSONS = "dictation:lessons-v4";
const SK_RESULTS = "dictation:results-v4";
const SK_TAGS = "dictation:tags-v1";
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // storage now backed by IndexedDB, so the cap is just a sane per-file ceiling, not a hard browser quota limit

function normalize(text) {
  return text.replace(/\([^)]*\)/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").replace(/\s+/g, " ").trim();
}

// Formats a byte count as a human-readable MB/GB string for the storage notice.
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

// Split one line into sentences on '.', '!', '?' (runs like "...", "?!" count as one boundary).
// A line with no terminal punctuation is kept as a single sentence.
function splitLineIntoSentences(line) {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  if (!parts) return [trimmed];
  return parts.map(s => s.trim()).filter(Boolean);
}

// Parse a full transcript/translation block into individual sentences:
// split on newlines first, then further split each line on . ! ?
function parseSentences(text) {
  if (!text) return [];
  return text.split("\n").flatMap(splitLineIntoSentences);
}

// Split one combined textarea into { transcript, translation } using a line
// of three-or-more dashes ("---") as the separator between the two blocks.
// If no separator is found, everything is treated as the transcript.
const SPLIT_MARKER_RE = /^[ \t]*-{3,}[ \t]*$/m;
function splitCombinedInput(text) {
  const raw = text || "";
  const match = raw.match(SPLIT_MARKER_RE);
  if (!match) return { transcript: raw.trim(), translation: "" };
  const idx = raw.indexOf(match[0]);
  return {
    transcript: raw.slice(0, idx).trim(),
    translation: raw.slice(idx + match[0].length).trim(),
  };
}

// Reverse of the above — used to pre-fill the combined textarea when editing
// a lesson that already has separate transcript/translation fields stored.
function joinCombinedInput(transcript, translation) {
  if (!translation) return transcript || "";
  return `${transcript || ""}\n---\n${translation}`;
}

function wordDiff(ref, input) {
  const rw = normalize(ref).split(/\s+/).filter(Boolean);
  const iw = normalize(input).split(/\s+/).filter(Boolean);
  if (rw.length === 0 && iw.length === 0) return { diff: [], accuracy: 1, isCorrect: true };
  if (rw.length === 0) return { diff: iw.map(w => ({ type: "extra", word: w })), accuracy: 0, isCorrect: false };
  const m = rw.length, n = iw.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = rw[i - 1] === iw[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  const diff = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && rw[i - 1] === iw[j - 1]) { diff.unshift({ type: "match", word: rw[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { diff.unshift({ type: "extra", word: iw[j - 1] }); j--; }
    else { diff.unshift({ type: "missing", word: rw[i - 1] }); i--; }
  }
  const mc = diff.filter(d => d.type === "match").length;
  return { diff, accuracy: rw.length > 0 ? mc / rw.length : 1, isCorrect: mc === rw.length && diff.every(d => d.type === "match") };
}

// Guess a proper audio MIME type from filename/browser-reported type.
// Many browsers report an empty or wrong file.type for audio picked via <input>,
// which produces a data URI like "data:;base64,..." that <audio> refuses to play (error code 4).
function guessAudioMime(filename, reportedType) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const extMap = {
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", mp4: "audio/mp4",
    ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
    webm: "audio/webm", opus: "audio/opus", wma: "audio/x-ms-wma",
  };
  if (reportedType && reportedType.startsWith("audio/")) return reportedType;
  return extMap[ext] || "audio/mpeg";
}

// Read a File into a data: URI, forcing the correct MIME type in the prefix.
const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const mime = guessAudioMime(file.name, file.type);
    // Replace whatever mime prefix FileReader produced with our verified one.
    const fixedDataUrl = String(reader.result).replace(/^data:[^;]*;/, `data:${mime};`);
    resolve({ dataUrl: fixedDataUrl, mime, name: file.name, size: file.size });
  };
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

// Convert the base64 payload of a data: URI into raw bytes for Web Audio decoding.
function dataUrlToArrayBuffer(dataUrl) {
  const b64 = dataUrl.split(",")[1] || "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Normalize a lesson's stored breakpoint for a sentence index into { start, end }.
// Older lessons stored a bare number (start time only) — treat that the same way.
function getBreakpoint(lesson, idx) {
  const raw = lesson?.breakpoints?.[idx];
  if (raw == null) return {};
  if (typeof raw === "number") return { start: raw };
  return raw;
}

// ---------- Design tokens: "studio bảng điều khiển âm thanh" ----------
const C = {
  ink: "#14181D", panel: "#1C222A", panel2: "#252D37", line: "#333C48",
  amber: "#F2A93B", amberDim: "rgba(242,169,59,0.14)", amberLine: "rgba(242,169,59,0.4)",
  text: "#ECEFF3", textSec: "#93A0AD", textMuted: "#5B6673",
  ok: "#5CD6A0", okBg: "rgba(92,214,160,0.14)",
  bad: "#FF7A7A", badBg: "rgba(255,122,122,0.14)",
  warn: "#F2A93B", warnBg: "rgba(242,169,59,0.14)",
  white: "#fff",
};

const FONT_HEAD = "'Space Grotesk', 'Segoe UI', system-ui, sans-serif";
const FONT_MONO = "'IBM Plex Mono', 'SF Mono', Consolas, monospace";
const FONT_BODY = "'Inter', 'Segoe UI', system-ui, sans-serif";

const FontImport = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700&display=swap');
    @keyframes bar-bounce { 0%,100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
    @keyframes pulse-ring { 0% { box-shadow: 0 0 0 0 rgba(242,169,59,0.35);} 100% { box-shadow: 0 0 0 8px rgba(242,169,59,0);} }
    input::placeholder, textarea::placeholder { color: #5B6673; }
    ::selection { background: rgba(242,169,59,0.35); }
  `}</style>
);

// Custom player built on the Web Audio API instead of <audio src="...">.
// Rationale: this sandbox appears to refuse both data: and blob: URIs as an
// <audio> source (error code 4) regardless of MIME correctness. Web Audio's
// decodeAudioData() works directly on bytes already in memory — no media
// element src is ever set, no network fetch happens — so it isn't subject to
// whatever media-src restriction is blocking the element-based approach.
const AudioPlayer = forwardRef(function AudioPlayer({ dataUrl, onPlayingChange, onErrorText, onTimeUpdate, markStart, markEnd }, ref) {
  const ctxRef = useRef(null);
  const bufferRef = useRef(null);
  const sourceRef = useRef(null);
  const startCtxTimeRef = useRef(0);
  const offsetRef = useRef(0);
  const rafRef = useRef(null);
  const endLimitRef = useRef(null); // optional hard stop time, set by playRange()
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const stopTicking = () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; };

  const stopSource = () => {
    if (sourceRef.current) {
      sourceRef.current.onended = null;
      try { sourceRef.current.stop(); } catch (e) {}
      sourceRef.current = null;
    }
  };

  const tick = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const t = ctx.currentTime - startCtxTimeRef.current;
    const limit = endLimitRef.current;
    if (limit != null && t >= limit) {
      stopSource(); stopTicking();
      offsetRef.current = limit; setCurrentTime(limit); setIsPlaying(false); onPlayingChange?.(false); onTimeUpdate?.(limit);
      endLimitRef.current = null;
      return;
    }
    if (t >= bufferRef.current.duration) {
      stopSource(); stopTicking();
      offsetRef.current = 0; setCurrentTime(0); setIsPlaying(false); onPlayingChange?.(false); onTimeUpdate?.(0);
      return;
    }
    setCurrentTime(t); onTimeUpdate?.(t);
    rafRef.current = requestAnimationFrame(tick);
  };

  const play = () => {
    const ctx = ctxRef.current;
    if (!ctx || !bufferRef.current) return;
    if (ctx.state === "suspended") ctx.resume();
    stopSource();
    const src = ctx.createBufferSource();
    src.buffer = bufferRef.current;
    src.connect(ctx.destination);
    src.start(0, offsetRef.current);
    startCtxTimeRef.current = ctx.currentTime - offsetRef.current;
    sourceRef.current = src;
    setIsPlaying(true); onPlayingChange?.(true);
    stopTicking(); rafRef.current = requestAnimationFrame(tick);
  };

  const pause = () => {
    const ctx = ctxRef.current;
    if (ctx && sourceRef.current) offsetRef.current = ctx.currentTime - startCtxTimeRef.current;
    stopSource(); stopTicking();
    setIsPlaying(false); onPlayingChange?.(false);
  };

  // Regular play/pause toggle always plays freely (no end limit).
  const togglePlayPause = () => { if (isPlaying) { pause(); } else { endLimitRef.current = null; play(); } };

  const seek = (t) => {
    const wasPlaying = isPlaying;
    endLimitRef.current = null;
    stopSource(); stopTicking();
    offsetRef.current = Math.max(0, Math.min(t, duration));
    setCurrentTime(offsetRef.current); onTimeUpdate?.(offsetRef.current);
    if (wasPlaying) play();
  };

  // Jump to a fixed point and always play from there, freely (no end limit).
  const playFrom = (t) => {
    endLimitRef.current = null;
    stopSource(); stopTicking();
    offsetRef.current = Math.max(0, Math.min(t, duration || t));
    setCurrentTime(offsetRef.current); onTimeUpdate?.(offsetRef.current);
    play();
  };

  // Play a bounded segment [start, end) — used to replay exactly one marked
  // sentence; playback stops automatically once it reaches `end`.
  const playRange = (start, end) => {
    stopSource(); stopTicking();
    offsetRef.current = Math.max(0, start);
    setCurrentTime(offsetRef.current); onTimeUpdate?.(offsetRef.current);
    endLimitRef.current = (typeof end === "number" && end > start) ? end : null;
    play();
  };

  useImperativeHandle(ref, () => ({ togglePlayPause, playFrom, playRange, pause, getCurrentTime: () => offsetRef.current }));

  useEffect(() => {
    stopSource(); stopTicking();
    offsetRef.current = 0; setCurrentTime(0); setIsPlaying(false); setDuration(0); endLimitRef.current = null;
    onPlayingChange?.(false); onTimeUpdate?.(0);
    if (!dataUrl) { setStatus("error"); onErrorText?.("Không có audio."); return; }
    setStatus("loading"); onErrorText?.(null);
    try {
      if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = dataUrlToArrayBuffer(dataUrl);
      ctxRef.current.decodeAudioData(
        arrayBuffer,
        (buf) => { bufferRef.current = buf; setDuration(buf.duration); setStatus("ready"); },
        () => { setStatus("error"); onErrorText?.("Không giải mã được file audio — có thể file bị hỏng hoặc định dạng không được hỗ trợ."); }
      );
    } catch (e) {
      setStatus("error"); onErrorText?.("Trình duyệt không hỗ trợ phát audio ở đây.");
    }
    return () => { stopSource(); stopTicking(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl]);

  useEffect(() => () => { if (ctxRef.current) ctxRef.current.close?.(); }, []);

  if (status === "loading") return <div style={{ color: C.textMuted, fontSize: 13 }}>Đang tải audio…</div>;
  if (status === "error") return null;

  const pct = (t) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);
  const hasStart = typeof markStart === "number";
  const hasEnd = typeof markEnd === "number";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <button
        onClick={togglePlayPause}
        aria-label={isPlaying ? "Tạm dừng" : "Phát"}
        style={{
          width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer", flexShrink: 0,
          background: C.amber, color: "#1A1305", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >{isPlaying ? "❚❚" : "▶"}</button>
      <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", height: 24 }}>
        {hasStart && hasEnd && (
          <div style={{
            position: "absolute", left: `${pct(markStart)}%`, width: `${Math.max(0, pct(markEnd) - pct(markStart))}%`,
            top: "50%", transform: "translateY(-50%)", height: 4, borderRadius: 2,
            background: "rgba(242,169,59,0.35)", pointerEvents: "none",
          }} />
        )}
        <input
          type="range" min={0} max={duration || 0} step={0.01} value={currentTime}
          onChange={e => seek(parseFloat(e.target.value))}
          style={{ flex: 1, accentColor: C.amber, position: "relative", zIndex: 2 }}
        />
        {hasStart && (
          <div title={`Điểm bắt đầu: ${formatTime(markStart)}`} style={{
            position: "absolute", left: `${pct(markStart)}%`, top: 0, transform: "translateX(-50%)",
            display: "flex", flexDirection: "column", alignItems: "center", pointerEvents: "none", zIndex: 1,
          }}>
            <span style={{ fontSize: 10, lineHeight: 1, color: C.ok }}>▼</span>
            <div style={{ width: 2, height: 24, background: C.ok, opacity: 0.7 }} />
          </div>
        )}
        {hasEnd && (
          <div title={`Điểm kết thúc: ${formatTime(markEnd)}`} style={{
            position: "absolute", left: `${pct(markEnd)}%`, top: 0, transform: "translateX(-50%)",
            display: "flex", flexDirection: "column", alignItems: "center", pointerEvents: "none", zIndex: 1,
          }}>
            <span style={{ fontSize: 10, lineHeight: 1, color: C.bad }}>▼</span>
            <div style={{ width: 2, height: 24, background: C.bad, opacity: 0.7 }} />
          </div>
        )}
      </div>
      <span style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT_MONO, minWidth: 78, textAlign: "right" }}>
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  );
});

function Waveform({ bars = 24, active = false, height = 28, color = C.amber }) {
  const heights = useRef(Array.from({ length: bars }, () => 20 + Math.random() * 80));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, height }}>
      {heights.current.map((h, i) => (
        <div key={i} style={{
          width: 3, borderRadius: 2, background: color, height: `${h}%`, opacity: active ? 1 : 0.35,
          animation: active ? `bar-bounce ${0.6 + (i % 5) * 0.12}s ease-in-out infinite` : "none",
          animationDelay: `${(i % 7) * 0.05}s`, transformOrigin: "center",
        }} />
      ))}
    </div>
  );
}

const btnBase = {
  fontFamily: FONT_HEAD, border: "none", cursor: "pointer", borderRadius: 10,
  fontWeight: 600, fontSize: 14, letterSpacing: "0.01em", transition: "all 0.15s",
};
const btnS = (v = "primary") => ({
  ...btnBase, padding: "11px 20px",
  ...(v === "primary" ? { background: C.amber, color: "#1A1305" } :
    v === "ghost" ? { background: "transparent", color: C.textSec, border: `1px solid ${C.line}` } :
    v === "danger" ? { background: C.badBg, color: C.bad, border: `1px solid rgba(255,122,122,0.3)` } :
    { background: C.panel2, color: C.text, border: `1px solid ${C.line}` })
});

const inpS = {
  width: "100%", padding: "12px 14px", borderRadius: 10, border: `1px solid ${C.line}`,
  background: C.panel, color: C.text, fontSize: 15, fontFamily: FONT_BODY,
  outline: "none", boxSizing: "border-box",
};

const cardS = {
  background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20, marginBottom: 12,
};

const labelS = { fontSize: 12, color: C.textMuted, marginBottom: 7, display: "block", fontFamily: FONT_HEAD, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" };

function Tag({ children, tone = "muted" }) {
  const map = {
    ok: { bg: C.okBg, color: C.ok }, warn: { bg: C.warnBg, color: C.warn },
    bad: { bg: C.badBg, color: C.bad }, muted: { bg: C.panel2, color: C.textMuted },
  }[tone];
  return <span style={{ fontSize: 10.5, background: map.bg, color: map.color, padding: "2px 7px", borderRadius: 5, fontWeight: 600, fontFamily: FONT_MONO, whiteSpace: "nowrap" }}>{children}</span>;
}

// Inline panel for choosing a level-1 tag and, optionally, one of its level-2
// sub-tags. Used both for tagging a single lesson and for bulk-tagging every
// currently selected lesson (see `label` for which one is active).
function TagPicker({ tags, level1, level2, onSelectLevel1, onSelectLevel2, onApply, onClear, onCancel, label }) {
  const activeLevel1 = tags.find(t => t.id === level1) || null;
  return (
    <div style={{ ...cardS, border: `1px solid ${C.amberLine}`, background: C.panel2, marginTop: -4 }}>
      <div style={{ fontSize: 12.5, color: C.textSec, marginBottom: 10, fontFamily: FONT_MONO }}>{label}</div>

      {tags.length === 0 ? (
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 10 }}>
          Chưa có nhãn nào. Vào "🏷 Quản lý nhãn" trong thư viện để tạo nhãn trước.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: activeLevel1?.children.length ? 10 : 0 }}>
            {tags.map(t => (
              <button key={t.id} onClick={() => onSelectLevel1(t.id === level1 ? null : t.id)}
                style={{ ...btnS(t.id === level1 ? "primary" : "outline"), padding: "6px 12px", fontSize: 12.5 }}>
                {t.name}
              </button>
            ))}
          </div>
          {activeLevel1 && activeLevel1.children.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 12, borderLeft: `2px solid ${C.line}` }}>
              {activeLevel1.children.map(c => (
                <button key={c.id} onClick={() => onSelectLevel2(c.id === level2 ? null : c.id)}
                  style={{ ...btnS(c.id === level2 ? "primary" : "ghost"), padding: "5px 11px", fontSize: 12 }}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button style={btnS("primary")} disabled={tags.length === 0} onClick={onApply}>Lưu nhãn</button>
        <button style={btnS("ghost")} onClick={onClear}>Bỏ nhãn</button>
        <button style={btnS("ghost")} onClick={onCancel}>Hủy</button>
      </div>
    </div>
  );
}

// Bare tag selector (no apply/clear/cancel buttons) meant to be embedded
// directly inside a form — e.g. the Add Lesson form or the inline Edit form —
// where the selection is saved together with the rest of the form.
function TagFields({ tags, level1, level2, onChangeLevel1, onChangeLevel2 }) {
  const activeLevel1 = tags.find(t => t.id === level1) || null;
  if (tags.length === 0) {
    return <div style={{ fontSize: 12.5, color: C.textMuted }}>Chưa có nhãn nào. Tạo nhãn trong "🏷 Quản lý nhãn" ở thư viện.</div>;
  }
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: activeLevel1?.children.length ? 10 : 0 }}>
        <button type="button" onClick={() => onChangeLevel1(null)}
          style={{ ...btnS(!level1 ? "primary" : "outline"), padding: "6px 12px", fontSize: 12.5 }}>Không gắn nhãn</button>
        {tags.map(t => (
          <button type="button" key={t.id} onClick={() => onChangeLevel1(t.id === level1 ? null : t.id)}
            style={{ ...btnS(t.id === level1 ? "primary" : "outline"), padding: "6px 12px", fontSize: 12.5 }}>
            {t.name}
          </button>
        ))}
      </div>
      {activeLevel1 && activeLevel1.children.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 12, borderLeft: `2px solid ${C.line}` }}>
          {activeLevel1.children.map(c => (
            <button type="button" key={c.id} onClick={() => onChangeLevel2(c.id === level2 ? null : c.id)}
              style={{ ...btnS(c.id === level2 ? "primary" : "ghost"), padding: "5px 11px", fontSize: 12 }}>
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AudioUploadBox({ hasAudio, label, onFileChange, small, error }) {
  const ref = useRef(null);
  return (
    <div
      style={{
        borderRadius: 12, cursor: "pointer", borderStyle: "dashed", borderWidth: 1.5,
        padding: small ? 14 : 26, textAlign: "center",
        background: hasAudio ? C.okBg : error ? C.badBg : C.panel2,
        borderColor: hasAudio ? "rgba(92,214,160,0.45)" : error ? "rgba(255,122,122,0.5)" : C.line,
      }}
      onClick={() => ref.current?.click()}
    >
      <input ref={ref} type="file" accept="audio/*" style={{ display: "none" }}
        onChange={e => { if (e.target.files[0]) onFileChange(e.target.files[0]); }} />
      {hasAudio ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
          <Waveform bars={12} height={small ? 16 : 20} active={false} color={C.ok} />
          <span style={{ color: C.ok, fontWeight: 600, fontSize: small ? 13 : 14, fontFamily: FONT_HEAD }}>{label}</span>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: small ? 20 : 26, marginBottom: small ? 4 : 8, opacity: 0.8 }}>{error ? "⚠️" : "＋"}</div>
          <div style={{ color: error ? C.bad : C.textSec, fontSize: small ? 12.5 : 13.5 }}>
            {error || "Chọn file audio (MP3, WAV...)"}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DictationApp() {
  const [page, setPage] = useState("library");
  const [lessons, setLessons] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentLesson, setCurrentLesson] = useState(null);
  const [tempAudioDataUrl, setTempAudioDataUrl] = useState(null);
  const [sentenceIdx, setSentenceIdx] = useState(0);
  const [userInput, setUserInput] = useState("");
  const [checkResult, setCheckResult] = useState(null);
  const [sentenceData, setSentenceData] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", content: "", level1TagId: null, level2TagId: null });
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [storageInfo, setStorageInfo] = useState(null); // { usage, quota } in bytes, or null if unavailable
  const [saving, setSaving] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioErr, setAudioErr] = useState(null);

  // Tags: a flat list of level-1 tags, each with its own list of level-2
  // sub-tags. A lesson carries at most one level-1 + one level-2 tag id pair.
  const [tags, setTags] = useState([]); // [{ id, name, children: [{ id, name }] }]
  const [newLevel1Name, setNewLevel1Name] = useState("");
  const [newLevel2Name, setNewLevel2Name] = useState({}); // { [level1Id]: draftText }
  const [tagDeleteConfirm, setTagDeleteConfirm] = useState(null); // { level1Id, level2Id? }
  // Tag picker (apply/clear/cancel flow): only used for bulk-tagging every
  // currently selected lesson at once — tagging a single lesson happens
  // inline inside its edit form instead (see editForm.level1TagId below).
  const [tagPickerTarget, setTagPickerTarget] = useState(null);
  const [pickerLevel1, setPickerLevel1] = useState(null);
  const [pickerLevel2, setPickerLevel2] = useState(null);
  // Library groups (one per level-1 tag) are collapsed by default, showing
  // just the header, until expanded — keeps a tagged library scannable.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  const [addName, setAddName] = useState("");
  const [addContent, setAddContent] = useState("");
  const [addAudio, setAddAudio] = useState(null); // {dataUrl,name,size}
  const [addAudioErr, setAddAudioErr] = useState(null);
  const [addLevel1TagId, setAddLevel1TagId] = useState(null);
  const [addLevel2TagId, setAddLevel2TagId] = useState(null);

  const [bulkEntries, setBulkEntries] = useState([{ name: "", content: "", audio: null, err: null }]);

  const audioPlayerRef = useRef(null);
  const audioTimeRef = useRef(0);
  const inputRef = useRef(null);

  useEffect(() => {
    (async () => {
      try { const d = await storage.get(SK_LESSONS); setLessons(JSON.parse(d.value)); } catch { setLessons([]); }
      try { const d = await storage.get(SK_RESULTS); setResults(JSON.parse(d.value)); } catch { setResults([]); }
      try { const d = await storage.get(SK_TAGS); setTags(JSON.parse(d.value)); } catch { setTags([]); }
      setLoading(false);
    })();
    refreshStorageInfo();
  }, []);

  // Reports how much storage the app (and the rest of the browser origin) is
  // using, via the Storage API. Not supported in every browser, so it fails
  // silently and simply hides the notice when unavailable.
  const refreshStorageInfo = async () => {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        setStorageInfo({ usage: est.usage || 0, quota: est.quota || 0 });
      }
    } catch {
      setStorageInfo(null);
    }
  };

  const saveLessons = async (ls) => {
    setLessons(ls);
    try { await storage.set(SK_LESSONS, JSON.stringify(ls)); } catch (e) { console.error(e); }
    refreshStorageInfo();
  };
  const saveResults = async (rs) => { setResults(rs); try { await storage.set(SK_RESULTS, JSON.stringify(rs)); } catch (e) { console.error(e); } };
  const saveTags = async (ts) => { setTags(ts); try { await storage.set(SK_TAGS, JSON.stringify(ts)); } catch (e) { console.error(e); } };

  useEffect(() => {
    if (page !== "practice") return;
    const handler = (e) => {
      if (e.key === "Shift") {
        e.preventDefault();
        replayFromBreakpoint();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        markStartBreakpoint();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        markEndBreakpoint();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [page, currentLesson, sentenceIdx]);

  const handleAudioFilePick = async (file, onDone, onErr) => {
    if (file.size > MAX_AUDIO_BYTES) {
      onErr(`File quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB). Giới hạn ~50MB/bài.`);
      return;
    }
    try {
      const res = await fileToDataUrl(file);
      onDone(res);
    } catch (e) {
      onErr("Không đọc được file audio.");
    }
  };

  const handleCheck = () => {
    if (!currentLesson) return;
    const sentences = parseSentences(currentLesson.transcript);
    const ref = sentences[sentenceIdx];
    const result = wordDiff(ref, userInput);
    setCheckResult(result);
    setSentenceData(prev => {
      const next = [...prev];
      if (!next[sentenceIdx]) next[sentenceIdx] = { attempts: 0, firstAccuracy: 0 };
      next[sentenceIdx].attempts += 1;
      if (next[sentenceIdx].attempts === 1) next[sentenceIdx].firstAccuracy = result.accuracy;
      return next;
    });
  };

  const handleNext = () => {
    const sentences = parseSentences(currentLesson.transcript);
    if (sentenceIdx < sentences.length - 1) {
      const nextIdx = sentenceIdx + 1;
      // Wherever the audio is currently sitting (paused or mid-play) becomes
      // the new start mark for the next sentence — auto-chaining boundaries
      // as you move through the lesson, without needing a manual mark each time.
      const t = audioTimeRef.current || 0;
      const existingNext = getBreakpoint(currentLesson, nextIdx);
      const breakpoints = { ...(currentLesson.breakpoints || {}), [nextIdx]: { ...existingNext, start: t } };
      const updatedLesson = { ...currentLesson, breakpoints };
      persistLessonUpdate(updatedLesson);
      setSentenceIdx(nextIdx);
      setUserInput("");
      setCheckResult(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      finishPractice();
    }
  };

  const finishPractice = async () => {
    const sentences = parseSentences(currentLesson.transcript);
    const overall = sentenceData.reduce((s, d) => s + (d?.firstAccuracy || 0), 0) / sentences.length;
    const record = {
      id: Date.now().toString(), lessonId: currentLesson.id, lessonName: currentLesson.name,
      date: new Date().toISOString(), overallAccuracy: overall, totalSentences: sentences.length,
      sentenceDetails: sentenceData.map((d, i) => ({ sentence: sentences[i], firstAccuracy: d?.firstAccuracy || 0, attempts: d?.attempts || 0 })),
    };
    await saveResults([...results, record]);
    setPage("results");
  };

  const startPractice = (lesson) => {
    setCurrentLesson(lesson);
    setSentenceIdx(0);
    setUserInput("");
    setCheckResult(null);
    setSentenceData([]);
    setAudioErr(null);
    if (lesson.audioDataUrl) {
      setTempAudioDataUrl(null);
      setPage("practice");
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setTempAudioDataUrl(null);
      setPage("uploadAudio");
    }
  };

  // Manual "break audio" points: remember, per sentence, exactly where in the
  // audio that sentence starts and ends, so replaying always jumps back to
  // that same segment. Backward-compatible with the earlier format where a
  // breakpoint was stored as a bare number (start time only).
  const persistLessonUpdate = async (updatedLesson) => {
    setCurrentLesson(updatedLesson);
    const next = lessons.map(l => l.id === updatedLesson.id ? updatedLesson : l);
    await saveLessons(next);
  };

  const markStartBreakpoint = () => {
    if (!currentLesson) return;
    const t = audioTimeRef.current || 0;
    const existing = getBreakpoint(currentLesson, sentenceIdx);
    const breakpoints = { ...(currentLesson.breakpoints || {}), [sentenceIdx]: { ...existing, start: t } };
    persistLessonUpdate({ ...currentLesson, breakpoints });
  };

  const markEndBreakpoint = () => {
    if (!currentLesson) return;
    const t = audioTimeRef.current || 0;
    const existing = getBreakpoint(currentLesson, sentenceIdx);
    const breakpoints = { ...(currentLesson.breakpoints || {}), [sentenceIdx]: { ...existing, end: t } };
    persistLessonUpdate({ ...currentLesson, breakpoints });
  };

  const clearBreakpoint = () => {
    if (!currentLesson) return;
    const breakpoints = { ...(currentLesson.breakpoints || {}) };
    delete breakpoints[sentenceIdx];
    persistLessonUpdate({ ...currentLesson, breakpoints });
  };

  const replayFromBreakpoint = () => {
    const bp = getBreakpoint(currentLesson, sentenceIdx);
    const start = typeof bp.start === "number" ? bp.start : 0;
    if (typeof bp.end === "number") audioPlayerRef.current?.playRange(start, bp.end);
    else audioPlayerRef.current?.playFrom(start);
  };

  const addLesson = async () => {
    const parsed = splitCombinedInput(addContent);
    if (!addName.trim() || !parsed.transcript) return;
    setSaving(true);
    const lesson = {
      id: Date.now().toString(), name: addName.trim(), transcript: parsed.transcript,
      translation: parsed.translation || null,
      createdAt: new Date().toISOString(), audioDataUrl: addAudio?.dataUrl || null, audioFileName: addAudio?.name || null,
      level1TagId: addLevel1TagId || null, level2TagId: addLevel2TagId || null,
    };
    await saveLessons([...lessons, lesson]);
    setAddName(""); setAddContent(""); setAddAudio(null); setAddAudioErr(null);
    setAddLevel1TagId(null); setAddLevel2TagId(null);
    setSaving(false);
    setPage("library");
  };

  const bulkAdd = async () => {
    const valid = bulkEntries.filter(e => e.name.trim() && splitCombinedInput(e.content).transcript);
    if (valid.length === 0) return;
    setSaving(true);
    const newLessons = valid.map((e, i) => {
      const parsed = splitCombinedInput(e.content);
      return {
        id: (Date.now() + i).toString(), name: e.name.trim(), transcript: parsed.transcript,
        translation: parsed.translation || null,
        createdAt: new Date().toISOString(), audioDataUrl: e.audio?.dataUrl || null, audioFileName: e.audio?.name || null,
      };
    });
    await saveLessons([...lessons, ...newLessons]);
    setBulkEntries([{ name: "", content: "", audio: null, err: null }]);
    setSaving(false);
    setPage("library");
  };

  const deleteLesson = async (id) => { await saveLessons(lessons.filter(l => l.id !== id)); setDeleteConfirm(null); };

  const toggleSelectMode = () => {
    setSelectMode(m => !m);
    setSelectedIds(new Set());
    setBulkDeleteConfirm(false);
  };

  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllLessons = () => setSelectedIds(new Set(lessons.map(l => l.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const deleteSelectedLessons = async () => {
    await saveLessons(lessons.filter(l => !selectedIds.has(l.id)));
    setSelectedIds(new Set());
    setSelectMode(false);
    setBulkDeleteConfirm(false);
  };

  // ---- Tags (level-1 categories + level-2 sub-tags, one pair per lesson) ----

  const findLevel1 = (id) => tags.find(t => t.id === id) || null;
  const findLevel2 = (level1Id, level2Id) => findLevel1(level1Id)?.children.find(c => c.id === level2Id) || null;

  const addLevel1Tag = async () => {
    const name = newLevel1Name.trim();
    if (!name) return;
    await saveTags([...tags, { id: Date.now().toString(), name, children: [] }]);
    setNewLevel1Name("");
  };

  const addLevel2Tag = async (level1Id) => {
    const name = (newLevel2Name[level1Id] || "").trim();
    if (!name) return;
    const next = tags.map(t => t.id === level1Id ? { ...t, children: [...t.children, { id: Date.now().toString(), name }] } : t);
    await saveTags(next);
    setNewLevel2Name(p => ({ ...p, [level1Id]: "" }));
  };

  const deleteLevel1Tag = async (level1Id) => {
    await saveTags(tags.filter(t => t.id !== level1Id));
    // Unassign this tag (and any of its sub-tags) from every lesson that had it.
    await saveLessons(lessons.map(l => l.level1TagId === level1Id ? { ...l, level1TagId: null, level2TagId: null } : l));
    setTagDeleteConfirm(null);
  };

  const deleteLevel2Tag = async (level1Id, level2Id) => {
    const next = tags.map(t => t.id === level1Id ? { ...t, children: t.children.filter(c => c.id !== level2Id) } : t);
    await saveTags(next);
    await saveLessons(lessons.map(l => l.level2TagId === level2Id ? { ...l, level2TagId: null } : l));
    setTagDeleteConfirm(null);
  };

  const openTagPicker = (target) => {
    if (target === "bulk") {
      setPickerLevel1(null);
      setPickerLevel2(null);
    } else {
      const lesson = lessons.find(l => l.id === target);
      setPickerLevel1(lesson?.level1TagId || null);
      setPickerLevel2(lesson?.level2TagId || null);
    }
    setTagPickerTarget(target);
  };

  const closeTagPicker = () => { setTagPickerTarget(null); setPickerLevel1(null); setPickerLevel2(null); };

  const applyTagPicker = async () => {
    if (tagPickerTarget === "bulk") {
      await saveLessons(lessons.map(l => selectedIds.has(l.id) ? { ...l, level1TagId: pickerLevel1, level2TagId: pickerLevel2 } : l));
    } else if (tagPickerTarget) {
      await saveLessons(lessons.map(l => l.id === tagPickerTarget ? { ...l, level1TagId: pickerLevel1, level2TagId: pickerLevel2 } : l));
    }
    closeTagPicker();
  };

  const clearTagPicker = async () => {
    if (tagPickerTarget === "bulk") {
      await saveLessons(lessons.map(l => selectedIds.has(l.id) ? { ...l, level1TagId: null, level2TagId: null } : l));
    } else if (tagPickerTarget) {
      await saveLessons(lessons.map(l => l.id === tagPickerTarget ? { ...l, level1TagId: null, level2TagId: null } : l));
    }
    closeTagPicker();
  };

  const saveEdit = async () => {
    const parsed = splitCombinedInput(editForm.content);
    if (!editForm.name.trim() || !parsed.transcript) return;
    const updated = lessons.map(l => l.id === editingId ? {
      ...l, name: editForm.name.trim(), transcript: parsed.transcript, translation: parsed.translation || null,
      level1TagId: editForm.level1TagId || null, level2TagId: editForm.level2TagId || null,
    } : l);
    await saveLessons(updated);
    setEditingId(null);
  };

  const getLastResult = (lessonId) => {
    const lr = results.filter(r => r.lessonId === lessonId);
    return lr.length > 0 ? lr[lr.length - 1] : null;
  };

  // Lessons are always shown alphabetically (A–Z) within their group.
  const sortAz = (arr) => [...arr].sort((a, b) => a.name.localeCompare(b.name, "vi", { sensitivity: "base" }));
  const getSortedLessons = () => sortAz(lessons);

  // Groups lessons by their level-1 tag for the library view: one section per
  // level-1 tag (alphabetical by tag name), lessons inside sorted A–Z, and a
  // trailing "Chưa gắn nhãn" section for anything without a tag.
  const getGroupedLessons = () => {
    const byTag = new Map(); // level1Id -> lessons[]
    const untagged = [];
    for (const lesson of lessons) {
      if (lesson.level1TagId && findLevel1(lesson.level1TagId)) {
        if (!byTag.has(lesson.level1TagId)) byTag.set(lesson.level1TagId, []);
        byTag.get(lesson.level1TagId).push(lesson);
      } else {
        untagged.push(lesson);
      }
    }
    const groups = [...byTag.entries()]
      .map(([level1Id, ls]) => ({ key: level1Id, level1Id, name: findLevel1(level1Id).name, lessons: sortAz(ls) }))
      .sort((a, b) => a.name.localeCompare(b.name, "vi", { sensitivity: "base" }));
    if (untagged.length > 0) groups.push({ key: "untagged", level1Id: null, name: "Chưa gắn nhãn", lessons: sortAz(untagged) });
    return groups;
  };

  const toggleGroupExpanded = (key) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const clearAllData = async () => {
    try { await storage.delete(SK_LESSONS); } catch {}
    try { await storage.delete(SK_RESULTS); } catch {}
    try { await storage.delete(SK_TAGS); } catch {}
    setLessons([]); setResults([]); setTags([]);
  };

  if (loading) return (
    <div style={{ minHeight: "100vh", background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontFamily: FONT_BODY }}>
      <FontImport />
      <div style={{ textAlign: "center" }}>
        <Waveform bars={16} active height={30} />
        <div style={{ color: C.textSec, marginTop: 10, fontFamily: FONT_MONO, fontSize: 13 }}>đang tải…</div>
      </div>
    </div>
  );

  const sentences = currentLesson ? parseSentences(currentLesson.transcript) : [];
  const translationSentences = currentLesson?.translation ? parseSentences(currentLesson.translation) : [];
  const currentTranslation = translationSentences[sentenceIdx] || null;
  const currentBp = getBreakpoint(currentLesson, sentenceIdx);
  const hasStartMark = typeof currentBp.start === "number";
  const hasEndMark = typeof currentBp.end === "number";
  const currentAudioSrc = currentLesson?.audioDataUrl || tempAudioDataUrl;

  return (
    <div style={{ minHeight: "100vh", background: C.ink, color: C.text, fontFamily: FONT_BODY }}>
      <FontImport />
      {/* Header */}
      <div style={{ background: C.panel, borderBottom: `1px solid ${C.line}`, padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }} onClick={() => setPage("library")}>
          <Waveform bars={5} height={20} active color={C.amber} />
          <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.2px", fontFamily: FONT_HEAD }}>DICTATION STUDIO</span>
        </div>
        {page !== "library" && page !== "results" && (
          <button style={btnS("ghost")} onClick={() => setPage("library")}>← Thư viện</button>
        )}
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "26px 16px" }}>

        {/* ===== LIBRARY ===== */}
        {page === "library" && (
          <>
            {storageInfo && storageInfo.quota > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
                  <span style={{ fontSize: 11.5, color: C.textMuted, fontFamily: FONT_MONO, textTransform: "uppercase", letterSpacing: "0.04em" }}>Dung lượng lưu trữ</span>
                  <span style={{ fontSize: 12, color: C.textSec, fontFamily: FONT_MONO }}>
                    {formatBytes(storageInfo.usage)} / {formatBytes(storageInfo.quota)}
                  </span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: C.panel2, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", borderRadius: 3,
                    width: `${Math.min(100, (storageInfo.usage / storageInfo.quota) * 100).toFixed(2)}%`,
                    background: (storageInfo.usage / storageInfo.quota) > 0.9 ? C.bad : (storageInfo.usage / storageInfo.quota) > 0.7 ? C.warn : C.amber,
                  }} />
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
              <button style={btnS("primary")} onClick={() => setPage("addLesson")}>＋ Thêm bài</button>
              <button style={btnS("outline")} onClick={() => setPage("bulkImport")}>▤ Thêm hàng loạt</button>
              <button style={btnS("ghost")} onClick={() => setPage("tags")}>🏷 Quản lý nhãn</button>
              {lessons.length > 0 && (
                <button style={{ ...btnS(selectMode ? "primary" : "ghost"), marginLeft: "auto" }} onClick={toggleSelectMode}>
                  {selectMode ? "Xong" : "Chọn nhiều"}
                </button>
              )}
            </div>

            {selectMode && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, color: C.textSec, fontFamily: FONT_MONO }}>Đã chọn {selectedIds.size}/{lessons.length}</span>
                <button style={{ ...btnS("ghost"), padding: "6px 12px", fontSize: 12.5 }} onClick={selectAllLessons}>Chọn tất cả</button>
                <button style={{ ...btnS("ghost"), padding: "6px 12px", fontSize: 12.5 }} onClick={clearSelection}>Bỏ chọn</button>
                <button style={{ ...btnS("outline"), padding: "6px 12px", fontSize: 12.5, opacity: selectedIds.size === 0 ? 0.5 : 1 }}
                  disabled={selectedIds.size === 0} onClick={() => openTagPicker("bulk")}>🏷 Gắn nhãn</button>
                {bulkDeleteConfirm ? (
                  <>
                    <button style={{ ...btnS("danger"), padding: "6px 12px", fontSize: 12.5 }} onClick={deleteSelectedLessons}>Xác nhận xóa {selectedIds.size} bài</button>
                    <button style={{ ...btnS("ghost"), padding: "6px 12px", fontSize: 12.5 }} onClick={() => setBulkDeleteConfirm(false)}>Hủy</button>
                  </>
                ) : (
                  <button style={{ ...btnS("danger"), padding: "6px 12px", fontSize: 12.5, opacity: selectedIds.size === 0 ? 0.5 : 1 }}
                    disabled={selectedIds.size === 0} onClick={() => setBulkDeleteConfirm(true)}>🗑 Xóa đã chọn</button>
                )}
              </div>
            )}

            {tagPickerTarget === "bulk" && (
              <TagPicker
                tags={tags} level1={pickerLevel1} level2={pickerLevel2}
                onSelectLevel1={(id) => { setPickerLevel1(id); setPickerLevel2(null); }}
                onSelectLevel2={setPickerLevel2}
                onApply={applyTagPicker} onClear={clearTagPicker} onCancel={closeTagPicker}
                label={`Gắn nhãn cho ${selectedIds.size} bài đã chọn`}
              />
            )}

            {lessons.length === 0 ? (
              <div style={{ textAlign: "center", padding: "70px 20px", color: C.textMuted }}>
                <Waveform bars={20} height={36} />
                <div style={{ fontSize: 16, marginTop: 18, marginBottom: 6, color: C.textSec, fontFamily: FONT_HEAD, fontWeight: 600 }}>Chưa có bài nào</div>
                <div style={{ fontSize: 13.5 }}>Thêm bài mới để bắt đầu luyện tập</div>
              </div>
            ) : getGroupedLessons().map(group => {
              const isExpanded = expandedGroups.has(group.key);
              return (
                <div key={group.key} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isExpanded ? 8 : 0, cursor: "pointer" }}
                    onClick={() => toggleGroupExpanded(group.key)}>
                    <span style={{ fontSize: 12, color: C.textMuted, width: 14, display: "inline-block", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: group.level1Id ? C.amber : C.textMuted, fontFamily: FONT_HEAD }}>
                      {group.name}
                    </span>
                    <span style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT_MONO }}>{group.lessons.length} bài</span>
                    <div style={{ flex: 1, height: 1, background: C.line }} />
                    <button style={{ ...btnS("ghost"), padding: "4px 10px", fontSize: 11.5 }}
                      onClick={(e) => { e.stopPropagation(); toggleGroupExpanded(group.key); }}>
                      {isExpanded ? "Thu gọn" : "Mở rộng"}
                    </button>
                  </div>

                  {isExpanded && group.lessons.map(lesson => {
                    const lr = getLastResult(lesson.id);
                    const sc = parseSentences(lesson.transcript).length;
                    const totalAttempts = results.filter(r => r.lessonId === lesson.id).length;
                    const hasAudio = !!lesson.audioDataUrl;
                    const isSelected = selectedIds.has(lesson.id);
                    const l1 = lesson.level1TagId ? findLevel1(lesson.level1TagId) : null;
                    const l2 = l1 && lesson.level2TagId ? findLevel2(lesson.level1TagId, lesson.level2TagId) : null;

                    if (editingId === lesson.id) return (
                      <div key={lesson.id} style={{ ...cardS, border: `1px solid ${C.amberLine}` }}>
                        <input style={{ ...inpS, marginBottom: 10 }} value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} placeholder="Tên bài" />
                        <textarea style={{ ...inpS, minHeight: 180, resize: "vertical", marginBottom: 14, fontFamily: FONT_MONO, fontSize: 13.5 }} value={editForm.content}
                          placeholder={"Transcript...\n---\nBản dịch (không bắt buộc)"}
                          onChange={e => setEditForm(p => ({ ...p, content: e.target.value }))} />
                        <label style={labelS}>Nhãn</label>
                        <div style={{ marginBottom: 14 }}>
                          <TagFields tags={tags} level1={editForm.level1TagId} level2={editForm.level2TagId}
                            onChangeLevel1={(id) => setEditForm(p => ({ ...p, level1TagId: id, level2TagId: null }))}
                            onChangeLevel2={(id) => setEditForm(p => ({ ...p, level2TagId: id }))} />
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button style={btnS("primary")} onClick={saveEdit}>Lưu</button>
                          <button style={btnS("ghost")} onClick={() => setEditingId(null)}>Hủy</button>
                        </div>
                      </div>
                    );

                    return (
                      <div key={lesson.id} style={{ ...cardS, padding: "12px 14px", marginBottom: 8, cursor: "pointer", border: `1px solid ${isSelected ? C.amberLine : C.line}` }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = C.amberLine}
                        onMouseLeave={e => e.currentTarget.style.borderColor = isSelected ? C.amberLine : C.line}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                          {selectMode && (
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelected(lesson.id)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: 18, height: 18, accentColor: C.amber, flexShrink: 0, cursor: "pointer" }} />
                          )}
                          <div onClick={() => selectMode ? toggleSelected(lesson.id) : startPractice(lesson)} style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 4 }}>
                              <span style={{ fontWeight: 700, fontSize: 14.5, fontFamily: FONT_HEAD, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                                {lesson.name}
                              </span>
                              {hasAudio ? <Tag tone="ok">● audio</Tag> : <Tag tone="warn">chưa audio</Tag>}
                              {lesson.translation && <Tag>dịch</Tag>}
                              <Tag>{sc} câu</Tag>
                              {totalAttempts > 0 && <Tag>{totalAttempts} lần</Tag>}
                              {l1 && <Tag tone="ok">{l1.name}{l2 ? ` ▸ ${l2.name}` : ""}</Tag>}
                              {lr && (
                                <span style={{ fontSize: 12, color: C.textSec, fontFamily: FONT_MONO }}>
                                  · <span style={{ color: lr.overallAccuracy >= 0.8 ? C.ok : lr.overallAccuracy >= 0.5 ? C.warn : C.bad, fontWeight: 700 }}>{Math.round(lr.overallAccuracy * 100)}%</span>
                                </span>
                              )}
                            </div>
                          </div>
                          {!selectMode && (
                            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                              <button style={{ ...btnS("ghost"), padding: "5px 9px", fontSize: 12 }}
                                onClick={(e) => { e.stopPropagation(); setEditingId(lesson.id); setEditForm({ name: lesson.name, content: joinCombinedInput(lesson.transcript, lesson.translation), level1TagId: lesson.level1TagId || null, level2TagId: lesson.level2TagId || null }); }}>✎</button>
                              {deleteConfirm === lesson.id ? (
                                <>
                                  <button style={{ ...btnS("danger"), padding: "5px 9px", fontSize: 12 }} onClick={(e) => { e.stopPropagation(); deleteLesson(lesson.id); }}>Xóa</button>
                                  <button style={{ ...btnS("ghost"), padding: "5px 9px", fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setDeleteConfirm(null); }}>Hủy</button>
                                </>
                              ) : (
                                <button style={{ ...btnS("ghost"), padding: "5px 9px", fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setDeleteConfirm(lesson.id); }}>🗑</button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {lessons.length > 0 && (
              <div style={{ marginTop: 30, textAlign: "center" }}>
                <button style={{ ...btnS("danger"), fontSize: 12, padding: "7px 14px" }} onClick={clearAllData}>Xóa toàn bộ dữ liệu</button>
              </div>
            )}
          </>
        )}

        {/* ===== TAG MANAGEMENT ===== */}
        {page === "tags" && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20, fontFamily: FONT_HEAD }}>Quản lý nhãn</h2>

            <div style={{ ...cardS, display: "flex", gap: 8 }}>
              <input style={inpS} value={newLevel1Name} onChange={e => setNewLevel1Name(e.target.value)}
                placeholder="Tên nhãn cấp 1 mới (VD: IELTS)"
                onKeyDown={e => { if (e.key === "Enter") addLevel1Tag(); }} />
              <button style={btnS("primary")} disabled={!newLevel1Name.trim()} onClick={addLevel1Tag}>Thêm</button>
            </div>

            {tags.length === 0 ? (
              <div style={{ textAlign: "center", padding: "50px 20px", color: C.textMuted, fontSize: 13.5 }}>
                Chưa có nhãn nào. Thêm nhãn cấp 1 để bắt đầu nhóm bài học.
              </div>
            ) : tags.map(t => (
              <div key={t.id} style={cardS}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ fontWeight: 700, fontSize: 14.5, fontFamily: FONT_HEAD, flex: 1 }}>{t.name}</span>
                  {tagDeleteConfirm?.level1Id === t.id && !tagDeleteConfirm.level2Id ? (
                    <>
                      <button style={{ ...btnS("danger"), padding: "5px 10px", fontSize: 12 }} onClick={() => deleteLevel1Tag(t.id)}>Xác nhận xóa</button>
                      <button style={{ ...btnS("ghost"), padding: "5px 10px", fontSize: 12 }} onClick={() => setTagDeleteConfirm(null)}>Hủy</button>
                    </>
                  ) : (
                    <button style={{ ...btnS("ghost"), padding: "5px 10px", fontSize: 12 }} onClick={() => setTagDeleteConfirm({ level1Id: t.id })}>🗑 Xóa nhãn này</button>
                  )}
                </div>

                {t.children.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                    {t.children.map(c => (
                      <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, background: C.panel2, borderRadius: 7, padding: "5px 6px 5px 10px" }}>
                        <span style={{ fontSize: 12.5 }}>{c.name}</span>
                        {tagDeleteConfirm?.level1Id === t.id && tagDeleteConfirm?.level2Id === c.id ? (
                          <>
                            <button style={{ ...btnS("danger"), padding: "3px 7px", fontSize: 11 }} onClick={() => deleteLevel2Tag(t.id, c.id)}>Xóa</button>
                            <button style={{ ...btnS("ghost"), padding: "3px 7px", fontSize: 11 }} onClick={() => setTagDeleteConfirm(null)}>Hủy</button>
                          </>
                        ) : (
                          <button style={{ ...btnS("ghost"), padding: "3px 7px", fontSize: 11 }} onClick={() => setTagDeleteConfirm({ level1Id: t.id, level2Id: c.id })}>✕</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: "flex", gap: 8 }}>
                  <input style={{ ...inpS, fontSize: 13 }} value={newLevel2Name[t.id] || ""}
                    onChange={e => setNewLevel2Name(p => ({ ...p, [t.id]: e.target.value }))}
                    placeholder="Tên nhãn cấp 2 (VD: Listening Part 3)"
                    onKeyDown={e => { if (e.key === "Enter") addLevel2Tag(t.id); }} />
                  <button style={{ ...btnS("outline"), fontSize: 13 }} disabled={!(newLevel2Name[t.id] || "").trim()} onClick={() => addLevel2Tag(t.id)}>+ Thêm</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ===== ADD LESSON ===== */}
        {page === "addLesson" && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20, fontFamily: FONT_HEAD }}>Thêm bài mới</h2>
            <div style={{ marginBottom: 18 }}>
              <label style={labelS}>Tên bài</label>
              <input style={inpS} value={addName} onChange={e => setAddName(e.target.value)} placeholder="VD: IELTS Listening Test 1" />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={labelS}>File audio</label>
              <AudioUploadBox hasAudio={!!addAudio} label={addAudio?.name} error={addAudioErr}
                onFileChange={f => { setAddAudioErr(null); handleAudioFilePick(f, setAddAudio, setAddAudioErr); }} />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={labelS}>Transcript + bản dịch (tự tách câu theo dấu . ! ?)</label>
              <textarea style={{ ...inpS, minHeight: 260, resize: "vertical", fontFamily: FONT_MONO, fontSize: 13.5, lineHeight: 1.6 }} value={addContent}
                onChange={e => setAddContent(e.target.value)}
                placeholder={
                  "Dán transcript (tiếng Anh), rồi tùy chọn thêm 1 dòng --- và dán bản dịch tiếng Việt bên dưới.\n\n" +
                  "VD:\nThis is a cat. It is small! Is it yours?\n---\nĐây là một con mèo. Nó nhỏ! Nó có phải của bạn không?\n\n" +
                  "(Nếu không có bản dịch, chỉ cần dán transcript, bỏ qua phần --- )\n(Nội dung trong ngoặc tròn sẽ bị bỏ qua khi chấm)"
                } />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={labelS}>Nhãn (tùy chọn)</label>
              <TagFields tags={tags} level1={addLevel1TagId} level2={addLevel2TagId}
                onChangeLevel1={(id) => { setAddLevel1TagId(id); setAddLevel2TagId(null); }}
                onChangeLevel2={setAddLevel2TagId} />
            </div>
            {addContent.trim() && (() => {
              const { transcript, translation } = splitCombinedInput(addContent);
              const enCount = parseSentences(transcript).length;
              const viCount = translation ? parseSentences(translation).length : null;
              const mismatch = viCount !== null && viCount !== enCount;
              return (
                <div style={{
                  marginBottom: 18, padding: "10px 14px", borderRadius: 10, fontSize: 13, fontFamily: FONT_MONO,
                  background: mismatch ? C.warnBg : C.amberDim, color: mismatch ? C.warn : C.textSec,
                }}>
                  {enCount} câu sẽ được tạo{viCount !== null && ` · ${viCount} câu dịch`}
                  {mismatch && " — số câu dịch không khớp, kiểm tra lại dấu câu"}
                </div>
              );
            })()}
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...btnS("primary"), opacity: saving ? 0.6 : 1 }} onClick={addLesson} disabled={!addName.trim() || !splitCombinedInput(addContent).transcript || saving}>
                {saving ? "Đang lưu…" : "Lưu bài"}
              </button>
              <button style={btnS("ghost")} onClick={() => { setAddName(""); setAddContent(""); setAddAudio(null); setAddLevel1TagId(null); setAddLevel2TagId(null); setPage("library"); }}>Hủy</button>
            </div>
          </div>
        )}

        {/* ===== BULK IMPORT ===== */}
        {page === "bulkImport" && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20, fontFamily: FONT_HEAD }}>Thêm hàng loạt</h2>
            {bulkEntries.map((entry, idx) => (
              <div key={idx} style={cardS}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 700, fontFamily: FONT_MONO }}>BÀI {String(idx + 1).padStart(2, "0")}</span>
                  {bulkEntries.length > 1 && (
                    <button style={{ background: "none", border: "none", color: C.bad, cursor: "pointer", fontSize: 18, padding: 4, lineHeight: 1 }}
                      onClick={() => setBulkEntries(prev => prev.filter((_, i) => i !== idx))}>×</button>
                  )}
                </div>
                <input style={{ ...inpS, marginBottom: 10 }} value={entry.name} placeholder="Tên bài"
                  onChange={e => { const n = [...bulkEntries]; n[idx] = { ...n[idx], name: e.target.value }; setBulkEntries(n); }} />
                <div style={{ marginBottom: 10 }}>
                  <AudioUploadBox small hasAudio={!!entry.audio} label={entry.audio?.name} error={entry.err}
                    onFileChange={f => {
                      const n = [...bulkEntries]; n[idx] = { ...n[idx], err: null }; setBulkEntries(n);
                      handleAudioFilePick(f,
                        (res) => setBulkEntries(prev => { const n2 = [...prev]; n2[idx] = { ...n2[idx], audio: res, err: null }; return n2; }),
                        (err) => setBulkEntries(prev => { const n2 = [...prev]; n2[idx] = { ...n2[idx], err }; return n2; }));
                    }} />
                </div>
                <textarea style={{ ...inpS, minHeight: 130, resize: "vertical", fontFamily: FONT_MONO, fontSize: 13, lineHeight: 1.6 }} value={entry.content}
                  placeholder={"Transcript...\n---\nBản dịch (không bắt buộc)"}
                  onChange={e => { const n = [...bulkEntries]; n[idx] = { ...n[idx], content: e.target.value }; setBulkEntries(n); }} />
                {entry.content.trim() && (() => {
                  const { transcript, translation } = splitCombinedInput(entry.content);
                  const enCount = parseSentences(transcript).length;
                  const viCount = translation ? parseSentences(translation).length : null;
                  const mismatch = viCount !== null && viCount !== enCount;
                  return (
                    <div style={{ marginTop: 8, fontSize: 12, fontFamily: FONT_MONO, color: mismatch ? C.warn : C.textMuted }}>
                      {enCount} câu{viCount !== null && ` · ${viCount} câu dịch`}{mismatch && " — lệch số câu"}
                    </div>
                  );
                })()}
              </div>
            ))}
            <button style={{ ...btnS("ghost"), width: "100%", marginBottom: 20, borderStyle: "dashed" }}
              onClick={() => setBulkEntries(prev => [...prev, { name: "", content: "", audio: null, err: null }])}>＋ Thêm bài</button>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...btnS("primary"), opacity: saving ? 0.6 : 1 }} onClick={bulkAdd}
                disabled={!bulkEntries.some(e => e.name.trim() && splitCombinedInput(e.content).transcript) || saving}>
                {saving ? "Đang lưu…" : `Lưu tất cả (${bulkEntries.filter(e => e.name.trim() && splitCombinedInput(e.content).transcript).length} bài)`}
              </button>
              <button style={btnS("ghost")} onClick={() => { setBulkEntries([{ name: "", content: "", audio: null, err: null }]); setPage("library"); }}>Hủy</button>
            </div>
          </div>
        )}

        {/* ===== UPLOAD AUDIO (lesson missing audio) ===== */}
        {page === "uploadAudio" && currentLesson && (
          <div style={{ textAlign: "center", padding: "40px 16px" }}>
            <Waveform bars={18} height={30} />
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "18px 0 6px", fontFamily: FONT_HEAD }}>{currentLesson.name}</h2>
            <p style={{ color: C.textSec, marginBottom: 22, fontSize: 13.5 }}>Bài này chưa có audio. Tải file lên để bắt đầu.</p>
            <AudioUploadBox hasAudio={!!tempAudioDataUrl} label="Đã chọn audio" error={audioErr}
              onFileChange={f => handleAudioFilePick(f, (res) => setTempAudioDataUrl(res.dataUrl), setAudioErr)} />
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 22 }}>
              <button style={btnS("primary")} onClick={() => { setPage("practice"); setTimeout(() => inputRef.current?.focus(), 100); }} disabled={!tempAudioDataUrl}>
                Bắt đầu luyện tập
              </button>
              <button style={btnS("ghost")} onClick={() => setPage("library")}>Quay lại</button>
            </div>
          </div>
        )}

        {/* ===== PRACTICE ===== */}
        {page === "practice" && currentLesson && (
          <div>
            <div style={{ ...cardS, padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
                <Waveform bars={20} active={audioPlaying} height={26} />
              </div>
              <AudioPlayer
                ref={audioPlayerRef}
                dataUrl={currentAudioSrc}
                onPlayingChange={setAudioPlaying}
                onErrorText={setAudioErr}
                onTimeUpdate={t => { audioTimeRef.current = t; }}
                markStart={hasStartMark ? currentBp.start : undefined}
                markEnd={hasEndMark ? currentBp.end : undefined}
              />
              {audioErr && <div style={{ color: C.bad, fontSize: 12.5, marginTop: 8 }}>{audioErr}</div>}

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.line}`, flexWrap: "wrap" }}>
                <button style={{ ...btnS("outline"), padding: "8px 14px", fontSize: 13 }} onClick={markStartBreakpoint}>
                  <span style={{ color: C.ok }}>▼</span> Đánh dấu điểm bắt đầu
                </button>
                <button style={{ ...btnS("outline"), padding: "8px 14px", fontSize: 13 }} onClick={markEndBreakpoint}>
                  <span style={{ color: C.bad }}>▼</span> Đánh dấu điểm kết thúc
                </button>
                {(hasStartMark || hasEndMark) && (
                  <button style={{ ...btnS("ghost"), padding: "8px 10px", fontSize: 13 }} onClick={clearBreakpoint} title="Xóa mốc">✕ Xóa mốc</button>
                )}
              </div>
              <div style={{ marginTop: 10 }}>
                <button style={{ ...btnS("primary"), padding: "8px 14px", fontSize: 13, width: "100%" }} onClick={replayFromBreakpoint}>
                  ↺ {hasStartMark && hasEndMark
                    ? `Nghe lại đoạn ${formatTime(currentBp.start)} – ${formatTime(currentBp.end)}`
                    : hasStartMark
                    ? `Nghe lại từ ${formatTime(currentBp.start)}`
                    : "Nghe lại từ đầu bài"}
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "center", margin: "12px 0 22px", flexWrap: "wrap" }}>
              {[["Shift", "Nghe lại đoạn đã đánh dấu"], ["Enter", "Kiểm tra"], ["↑", "Đánh dấu điểm bắt đầu"], ["↓", "Đánh dấu điểm kết thúc"]].map(([key, label]) => (
                <span key={key} style={{ fontSize: 12, color: C.textMuted }}>
                  <span style={{ background: C.panel2, padding: "3px 9px", borderRadius: 5, fontWeight: 700, fontSize: 11, color: C.text, marginRight: 6, fontFamily: FONT_MONO }}>{key}</span>
                  {label}
                </span>
              ))}
            </div>

            <div style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
                <span style={{ fontWeight: 700, fontSize: 17, fontFamily: FONT_HEAD }}>Câu {sentenceIdx + 1} / {sentences.length}</span>
                <span style={{ fontSize: 12.5, color: C.textMuted, fontFamily: FONT_MONO }}>{currentLesson.name}</span>
              </div>
              <div style={{ height: 4, background: C.panel2, borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", background: C.amber, borderRadius: 2, transition: "width 0.3s", width: `${(sentenceIdx / sentences.length) * 100}%` }} />
              </div>
            </div>

            <div style={{ ...cardS, padding: 0, overflow: "hidden" }}>
              <input ref={inputRef}
                style={{ ...inpS, border: "none", borderRadius: 0, padding: "17px 18px", fontSize: 16, background: checkResult?.isCorrect ? C.okBg : "transparent" }}
                value={userInput}
                onChange={e => { if (!checkResult?.isCorrect) setUserInput(e.target.value); }}
                onKeyDown={e => {
                  if (e.key === "Enter") { e.preventDefault(); checkResult?.isCorrect ? handleNext() : handleCheck(); }
                  if (e.key === "Shift") { e.preventDefault(); replayFromBreakpoint(); }
                }}
                placeholder="Nghe và gõ lại câu bạn nghe được..."
                readOnly={checkResult?.isCorrect}
              />
              <div style={{ borderTop: `1px solid ${C.line}`, padding: "11px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                {checkResult?.isCorrect ? (
                  <>
                    <span style={{ color: C.ok, fontWeight: 700, fontSize: 14 }}>✓ Chính xác!</span>
                    <button style={btnS("primary")} onClick={handleNext}>{sentenceIdx < sentences.length - 1 ? "Câu tiếp →" : "Hoàn thành ✓"}</button>
                  </>
                ) : (
                  <>
                    {checkResult && <span style={{ color: C.bad, fontSize: 13 }}>Sửa lại rồi bấm Enter</span>}
                    <button style={{ ...btnS("primary"), marginLeft: "auto" }} onClick={handleCheck} disabled={!userInput.trim()}>Kiểm tra</button>
                  </>
                )}
              </div>
            </div>

            {checkResult && !checkResult.isCorrect && (
              <div style={{ ...cardS, marginTop: 0 }}>
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, fontWeight: 700, fontFamily: FONT_MONO, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  So sánh — {Math.round(checkResult.accuracy * 100)}% đúng
                </div>
                <div style={{ lineHeight: 2, fontSize: 15 }}>
                  {checkResult.diff.map((d, i) => (
                    <span key={i} style={{
                      padding: "2px 4px", borderRadius: 4, marginRight: 4,
                      ...(d.type === "match" ? { color: C.ok } :
                        d.type === "missing" ? { background: C.badBg, color: C.bad, textDecoration: "line-through" } :
                        { background: C.warnBg, color: C.warn })
                    }}>
                      {d.word}
                      {d.type === "missing" && <span style={{ fontSize: 9, verticalAlign: "super", marginLeft: 2 }}>thiếu</span>}
                      {d.type === "extra" && <span style={{ fontSize: 9, verticalAlign: "super", marginLeft: 2 }}>thừa</span>}
                    </span>
                  ))}
                </div>
                <div style={{ marginTop: 12, padding: "11px 13px", background: C.amberDim, borderRadius: 8, fontSize: 13, color: C.textSec }}>
                  <strong style={{ color: C.text }}>Đáp án:</strong> {sentences[sentenceIdx].replace(/\([^)]*\)/g, "").trim()}
                </div>
                {currentTranslation && (
                  <div style={{ marginTop: 8, padding: "11px 13px", background: C.panel2, borderRadius: 8, fontSize: 13, color: C.textSec }}>
                    <strong style={{ color: C.text }}>Nghĩa:</strong> {currentTranslation}
                  </div>
                )}
              </div>
            )}

            {checkResult?.isCorrect && (
              <div style={{ ...cardS, marginTop: 0, background: C.okBg, borderColor: "rgba(92,214,160,0.4)" }}>
                <div style={{ color: C.ok, fontWeight: 700, fontSize: 14 }}>
                  {sentenceData[sentenceIdx]?.attempts === 1 ? "Đúng ngay lần đầu!" : `Đúng sau ${sentenceData[sentenceIdx]?.attempts} lần thử`}
                </div>
                {currentTranslation && (
                  <div style={{ marginTop: 10, fontSize: 13, color: C.text }}>
                    <strong>Nghĩa:</strong> {currentTranslation}
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: 22, display: "flex", gap: 4, flexWrap: "wrap" }}>
              {sentences.map((_, i) => {
                const done = sentenceData[i]?.firstAccuracy !== undefined;
                const cur = i === sentenceIdx;
                return (
                  <div key={i} style={{
                    width: 28, height: 28, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 700, fontFamily: FONT_MONO,
                    ...(cur ? { background: C.amber, color: "#1A1305", animation: "pulse-ring 1.6s infinite" } :
                      done ? { background: C.okBg, color: C.ok } :
                      { background: C.panel2, color: C.textMuted })
                  }}>{i + 1}</div>
                );
              })}
            </div>

            <div style={{ textAlign: "center", marginTop: 26 }}>
              <button style={{ ...btnS("ghost"), fontSize: 12 }} onClick={finishPractice}>Kết thúc sớm</button>
            </div>
          </div>
        )}

        {/* ===== RESULTS ===== */}
        {page === "results" && (() => {
          const r = results[results.length - 1];
          if (!r) return null;
          const acc = r.overallAccuracy;
          return (
            <div style={{ textAlign: "center" }}>
              <Waveform bars={24} active height={40} color={acc >= 0.8 ? C.ok : acc >= 0.5 ? C.warn : C.bad} />
              <h2 style={{ fontSize: 22, fontWeight: 700, margin: "18px 0 4px", fontFamily: FONT_HEAD }}>Kết quả luyện tập</h2>
              <p style={{ color: C.textSec, marginBottom: 20, fontSize: 13.5 }}>{r.lessonName}</p>

              <div style={{ fontSize: 62, fontWeight: 700, letterSpacing: "-2px", marginBottom: 24, fontFamily: FONT_MONO, color: acc >= 0.8 ? C.ok : acc >= 0.5 ? C.warn : C.bad }}>
                {Math.round(acc * 100)}%
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 28, flexWrap: "wrap" }}>
                {[["Tổng câu", r.totalSentences], ["Đúng lần đầu", r.sentenceDetails?.filter(s => s.firstAccuracy === 1).length || 0],
                  ["TB số lần thử", (r.sentenceDetails?.reduce((s, d) => s + d.attempts, 0) / r.totalSentences).toFixed(1)]].map(([label, val]) => (
                  <div key={label} style={{ ...cardS, minWidth: 105, marginBottom: 0, padding: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: C.text, fontFamily: FONT_MONO }}>{val}</div>
                    <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 4 }}>{label}</div>
                  </div>
                ))}
              </div>

              <div style={{ textAlign: "left" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: C.textMuted, fontFamily: FONT_MONO, textTransform: "uppercase", letterSpacing: "0.05em" }}>Chi tiết từng câu</h3>
                {r.sentenceDetails?.map((s, i) => (
                  <div key={i} style={{ ...cardS, display: "flex", alignItems: "center", gap: 12, padding: 14 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 13, fontWeight: 700, flexShrink: 0, fontFamily: FONT_MONO,
                      background: s.firstAccuracy === 1 ? C.okBg : s.firstAccuracy >= 0.5 ? C.warnBg : C.badBg,
                      color: s.firstAccuracy === 1 ? C.ok : s.firstAccuracy >= 0.5 ? C.warn : C.bad,
                    }}>{i + 1}</div>
                    <div style={{ flex: 1, fontSize: 13, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.sentence}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, flexShrink: 0, fontFamily: FONT_MONO, color: s.firstAccuracy === 1 ? C.ok : s.firstAccuracy >= 0.5 ? C.warn : C.bad }}>
                      {Math.round(s.firstAccuracy * 100)}%
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted, flexShrink: 0, fontFamily: FONT_MONO }}>{s.attempts}×</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 28, flexWrap: "wrap" }}>
                <button style={btnS("primary")} onClick={() => setPage("library")}>Quay lại thư viện</button>
                <button style={btnS("outline")} onClick={() => startPractice(currentLesson)}>Luyện lại</button>
              </div>

              {(() => {
                const ordered = getSortedLessons();
                const idx = ordered.findIndex(l => l.id === r.lessonId);
                const nextLesson = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null;
                if (!nextLesson) return null;
                return (
                  <div style={{ marginTop: 14 }}>
                    <button style={{ ...btnS("primary"), width: "100%", padding: "13px 20px" }} onClick={() => startPractice(nextLesson)}>
                      Bài tiếp theo: {nextLesson.name} →
                    </button>
                  </div>
                );
              })()}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
