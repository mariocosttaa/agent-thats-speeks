"use client";

import { sendChat, type ChatMessage } from "@/lib/chat-api";
import { getNaturalVoicesForLocale } from "@/lib/tts-voices";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const LOCALES = [
  { value: "pt-PT", label: "Português (Portugal)" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
] as const;

type LocaleValue = (typeof LOCALES)[number]["value"];
type ConversationMode = "live" | "ptt";

function getSpeechRecognitionCtor(): new () => SpeechRecognition {
  if (typeof window === "undefined") {
    throw new Error("SpeechRecognition is only available in the browser");
  }
  const w = window as Window & {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) {
    throw new Error("Speech recognition is not supported in this browser");
  }
  return Ctor;
}

export function VoiceAssistant() {
  const [locale, setLocale] = useState<LocaleValue>("pt-PT");
  const [mode, setMode] = useState<ConversationMode>("live");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const [listening, setListening] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceUri, setVoiceUri] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const messagesRef = useRef<ChatMessage[]>([]);
  const busyRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const intentionalStopRef = useRef(false);
  const liveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveBufferRef = useRef<string[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const localeRef = useRef(locale);
  const voiceUriRef = useRef(voiceUri);
  const voicesRef = useRef(voices);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  useEffect(() => {
    voiceUriRef.current = voiceUri;
  }, [voiceUri]);
  useEffect(() => {
    voicesRef.current = voices;
  }, [voices]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "audioinput"));
    } catch {
      setDevices([]);
    }
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setLevel(0);
  }, []);

  const startMeter = useCallback(
    async (selectedId: string) => {
      stopMeter();
      try {
        const constraints: MediaStreamConstraints = {
          audio: selectedId
            ? { deviceId: { exact: selectedId }, echoCancellation: true }
            : { echoCancellation: true },
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.65;
        source.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          const a = analyserRef.current;
          if (!a) return;
          a.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i]! - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          setLevel(Math.min(100, Math.round(rms * 280)));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        setMicReady(true);
        await refreshDevices();
      } catch (e) {
        setMicReady(false);
        setError(e instanceof Error ? e.message : "Microphone access failed");
      }
    },
    [refreshDevices, stopMeter],
  );

  const speakReply = useCallback((text: string, loc: string) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = loc;
    const v = voicesRef.current.find((x) => x.voiceURI === voiceUriRef.current);
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }, []);

  const submitUserText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const userMsg: ChatMessage = { role: "user", content: trimmed };
      const history = [...messagesRef.current, userMsg];
      messagesRef.current = history;
      setMessages(history);
      const loc = localeRef.current;
      try {
        const reply = await sendChat(history, loc);
        const modelMsg: ChatMessage = { role: "model", content: reply };
        const withModel = [...history, modelMsg];
        messagesRef.current = withModel;
        setMessages(withModel);
        speakReply(reply, loc);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Chat request failed");
        const rolled = history.slice(0, -1);
        messagesRef.current = rolled;
        setMessages(rolled);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [speakReply],
  );

  const scheduleLiveFlush = useCallback(() => {
    if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
    liveDebounceRef.current = setTimeout(() => {
      liveDebounceRef.current = null;
      const parts = liveBufferRef.current.map((s) => s.trim()).filter(Boolean);
      liveBufferRef.current = [];
      const joined = parts.join(" ").trim();
      if (joined) void submitUserText(joined);
    }, 900);
  }, [submitUserText]);

  const stopRecognition = useCallback(() => {
    intentionalStopRef.current = true;
    const r = recognitionRef.current;
    recognitionRef.current = null;
    if (r) {
      try {
        r.stop();
      } catch {
        try {
          r.abort();
        } catch {
          /* ignore */
        }
      }
    }
    setListening(false);
    setInterim("");
  }, []);

  const attachRecognitionHandlers = useCallback(
    (r: SpeechRecognition, isLive: boolean) => {
      r.onresult = (ev: SpeechRecognitionEvent) => {
        let interimPiece = "";
        let finals = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i]!;
          const t = res[0]?.transcript ?? "";
          if (res.isFinal) finals += t;
          else interimPiece += t;
        }
        if (isLive) {
          setInterim(interimPiece);
          if (finals.trim()) {
            liveBufferRef.current.push(finals.trim());
            scheduleLiveFlush();
          }
        } else {
          setInterim(interimPiece);
          if (finals.trim()) void submitUserText(finals.trim());
        }
      };
      r.onerror = (ev: SpeechRecognitionErrorEvent) => {
        if (ev.error === "no-speech" && isLive) return;
        if (ev.error === "aborted") return;
        setError(`${ev.error}: ${ev.message || ""}`.trim());
      };
      r.onstart = () => {
        intentionalStopRef.current = false;
        setListening(true);
      };
      r.onend = () => {
        setListening(false);
        setInterim("");
        if (intentionalStopRef.current || !isLive) return;
        const cur = recognitionRef.current;
        if (cur === r) {
          try {
            r.lang = localeRef.current;
            r.start();
          } catch {
            /* ignore */
          }
        }
      };
    },
    [scheduleLiveFlush, submitUserText],
  );

  const startLiveRecognition = useCallback(() => {
    setError(null);
    stopRecognition();
    intentionalStopRef.current = false;
    liveBufferRef.current = [];
    const Ctor = getSpeechRecognitionCtor();
    const r = new Ctor();
    r.lang = localeRef.current;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    attachRecognitionHandlers(r, true);
    recognitionRef.current = r;
    r.start();
  }, [attachRecognitionHandlers, stopRecognition]);

  const startPttRecognition = useCallback(() => {
    setError(null);
    const Ctor = getSpeechRecognitionCtor();
    const r = new Ctor();
    r.lang = localeRef.current;
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    attachRecognitionHandlers(r, false);
    recognitionRef.current = r;
    intentionalStopRef.current = false;
    r.start();
  }, [attachRecognitionHandlers]);

  useEffect(() => {
    const loadVoices = () => {
      const v = speechSynthesis.getVoices();
      setVoices(v);
      const curated = getNaturalVoicesForLocale(v, localeRef.current);
      setVoiceUri((prev) => {
        if (prev && curated.some((x) => x.voiceURI === prev)) return prev;
        return curated[0]?.voiceURI ?? "";
      });
    };
    loadVoices();
    speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, []);

  useEffect(() => {
    const curated = getNaturalVoicesForLocale(voices, locale);
    if (voiceUri && !curated.some((x) => x.voiceURI === voiceUri)) {
      setVoiceUri(curated[0]?.voiceURI ?? "");
    }
  }, [locale, voiceUri, voices]);

  useEffect(() => {
    const r = recognitionRef.current;
    if (r) r.lang = locale;
  }, [locale]);

  useEffect(() => {
    return () => {
      stopRecognition();
      stopMeter();
      speechSynthesis.cancel();
      if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
    };
  }, [stopRecognition, stopMeter]);

  const onEnableMic = () => {
    setError(null);
    void startMeter(deviceId || "");
  };

  const curatedVoices = useMemo(
    () => getNaturalVoicesForLocale(voices, locale),
    [voices, locale],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Voice assistant
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Chromium recommended (Chrome / Edge). Speech-to-text uses the browser
          engine; the level meter uses your selected microphone. STT may still
          use the system default input on some platforms.
        </p>
      </header>

      <div className="grid gap-4 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-900/50 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Input language
          </span>
          <select
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
            value={locale}
            onChange={(e) => {
              setLocale(e.target.value as LocaleValue);
            }}
          >
            {LOCALES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Natural voice (TTS)
          </span>
          <select
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
            value={voiceUri}
            onChange={(e) => setVoiceUri(e.target.value)}
          >
            {curatedVoices.length === 0 ? (
              <option value="">Loading voices…</option>
            ) : (
              curatedVoices.map((v, i) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {i === 0 ? "★ " : ""}
                  {v.name} ({v.lang})
                </option>
              ))
            )}
          </select>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            List limited to higher-quality, natural-sounding voices (Google /
            neural-style hints). Use Chrome or Edge for the best set.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Microphone (level meter)
          </span>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">System default</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Mic ${d.deviceId.slice(0, 8)}…`}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void startMeter(deviceId)}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Apply mic
            </button>
          </div>
        </label>

        <div className="sm:col-span-2">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Input level
          </span>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-[width] duration-75"
              style={{ width: `${level}%` }}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
            <span
              className={`inline-block h-2 w-2 rounded-full ${listening ? "animate-pulse bg-emerald-500" : "bg-zinc-400"}`}
            />
            {listening ? "Listening…" : "Idle"}
            {interim ? (
              <span className="truncate text-zinc-600 dark:text-zinc-400">
                · {interim}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Mode
          </span>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: "live" as const, label: "Live conversation" },
                { id: "ptt" as const, label: "Push to talk" },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setMode(m.id);
                  stopRecognition();
                }}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  mode === m.id
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!micReady ? (
          <button
            type="button"
            onClick={onEnableMic}
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            Allow microphone
          </button>
        ) : null}

        {mode === "live" ? (
          <button
            type="button"
            onClick={() =>
              listening ? stopRecognition() : startLiveRecognition()
            }
            disabled={!micReady || busy}
            className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {listening ? "Stop listening" : "Start listening"}
          </button>
        ) : (
          <button
            type="button"
            disabled={!micReady || busy}
            onPointerDown={() => {
              if (!micReady || busyRef.current) return;
              stopRecognition();
              startPttRecognition();
            }}
            onPointerUp={() => {
              const r = recognitionRef.current;
              if (r) {
                try {
                  r.stop();
                } catch {
                  /* ignore */
                }
              }
            }}
            onPointerLeave={() => {
              const r = recognitionRef.current;
              if (r) {
                try {
                  r.stop();
                } catch {
                  /* ignore */
                }
              }
            }}
            className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Hold to speak
          </button>
        )}

        <button
          type="button"
          onClick={() => speechSynthesis.cancel()}
          className="rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Stop voice
        </button>

        {busy ? (
          <span className="text-sm text-zinc-500">Assistant is thinking…</span>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      ) : null}

      <section className="flex min-h-[240px] flex-col rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Conversation
        </h2>
        <div className="flex max-h-[420px] flex-col gap-3 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Speak or hold Push to talk. Messages appear here.
            </p>
          ) : (
            messages.map((m, i) => (
              <div
                key={`${i}-${m.role}-${m.content.slice(0, 24)}`}
                className={`max-w-[95%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "self-end bg-emerald-600 text-white"
                    : "self-start border border-zinc-200 bg-zinc-50 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                }`}
              >
                {m.content}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
