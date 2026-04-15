// Helpers — pick browser TTS voices that tend to sound most natural (Chrome/Edge heuristics).

/** BCP-47 style match for STT/TTS locale selection. */
export function voiceMatchesLocale(
  voice: SpeechSynthesisVoice,
  locale: string,
): boolean {
  const vl = voice.lang.toLowerCase().replace("_", "-");
  const loc = locale.toLowerCase();
  if (vl === loc) return true;
  const base = loc.split("-")[0];
  const vb = vl.split("-")[0];
  return vb === base;
}

function naturalnessScore(voice: SpeechSynthesisVoice, locale: string): number {
  const n = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  const vl = voice.lang.toLowerCase().replace("_", "-");
  const loc = locale.toLowerCase();
  let s = 0;
  // Prefer exact regional match (e.g. pt-PT vs generic pt).
  if (vl === loc) s += 32;
  else if (vl.split("-")[0] === loc.split("-")[0]) s += 10;

  // Engines that usually sound more human-like in Chromium.
  const boosts: [RegExp, number][] = [
    [/google/, 36],
    [/wavenet/, 40],
    [/neural/, 38],
    [/premium/, 32],
    [/enhanced/, 28],
    [/natural/, 26],
    [/microsoft/, 24],
    [/azure/, 22],
    [/siri/, 20],
  ];
  for (const [re, pts] of boosts) {
    if (re.test(n)) s += pts;
  }

  // Novelty / low-quality or toy voices common on macOS.
  const junk: [RegExp, number][] = [
    [/compact/, -90],
    [/\bpipe\b|\bpipes\b/i, -50],
    [/bad news|rocko|zarvox|hysterical|boing|bubbles/i, -55],
    [/whispering|whisper/i, -25],
  ];
  for (const [re, pts] of junk) {
    if (re.test(n)) s += pts;
  }

  // Regional hints: names that often map to stronger default voices.
  if (loc === "pt-pt") {
    const ptHints: [RegExp, number][] = [
      [/joana|luciana|inês|ines/, 22],
      [/google.*portugal|portugal|portugu[eê]s.*europe|european portuguese/i, 20],
    ];
    for (const [re, pts] of ptHints) {
      if (re.test(n)) s += pts;
    }
  }
  if (loc === "pt-br") {
    const brHints: [RegExp, number][] = [
      [/francisca|thais|thiago|antonio|antônio|google/i, 20],
      [/brazil|brasil/i, 14],
    ];
    for (const [re, pts] of brHints) {
      if (re.test(n)) s += pts;
    }
  }
  if (loc === "en-us") {
    const usHints: [RegExp, number][] = [
      [/samantha|aaron|susan|allison|flo|serena|google.*us|united states/i, 20],
    ];
    for (const [re, pts] of usHints) {
      if (re.test(n)) s += pts;
    }
  }
  if (loc === "en-gb") {
    const gbHints: [RegExp, number][] = [
      [/daniel|martha|arthur|thomas|google.*uk|british|united kingdom|received pronunciation/i, 20],
    ];
    for (const [re, pts] of gbHints) {
      if (re.test(n)) s += pts;
    }
  }

  // Cloud / non-local voices often align with higher-quality synthesis in Chrome.
  if (!voice.localService && /google|microsoft|neural|premium|natural|wavenet/i.test(n)) {
    s += 10;
  }

  return s;
}

/**
 * Returns a short list of the most natural-sounding voices for the UI locale.
 * Falls back to best-ranked matches if the browser exposes few voices.
 */
export function getNaturalVoicesForLocale(
  voices: SpeechSynthesisVoice[],
  locale: string,
): SpeechSynthesisVoice[] {
  const matched = voices.filter((v) => voiceMatchesLocale(v, locale));
  if (matched.length === 0) return [];

  let ranked = matched
    .map((v) => ({ v, score: naturalnessScore(v, locale) }))
    .filter(({ score }) => score > -45);

  ranked.sort((a, b) => b.score - a.score);

  // Unusual engines: still offer a few best-effort picks instead of an empty list.
  if (ranked.length === 0) {
    ranked = matched
      .map((v) => ({ v, score: naturalnessScore(v, locale) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  const best = ranked[0]?.score ?? 0;
  // Keep voices close to the top score so the list stays small and “premium-only”.
  const cutoff = Math.max(14, best - 30);
  let chosen = ranked.filter((r) => r.score >= cutoff);

  if (chosen.length < 2 && ranked.length >= 2) {
    chosen = ranked.slice(0, Math.min(5, ranked.length));
  }
  if (chosen.length === 0) {
    chosen = ranked.slice(0, Math.min(4, ranked.length));
  }

  // De-dupe by voiceURI while preserving order.
  const seen = new Set<string>();
  const out: SpeechSynthesisVoice[] = [];
  for (const { v } of chosen) {
    if (seen.has(v.voiceURI)) continue;
    seen.add(v.voiceURI);
    out.push(v);
  }
  return out;
}
