// Web Speech API wrappers for Listen mode and the spoken turn instructions:
// `speechSynthesis` for output (hi-IN / en-IN voices when the device has them)
// and `SpeechRecognition` / `webkitSpeechRecognition` for input. Both are
// optional: callers check `ttsSupported()` / `sttSupported()` and fall back to
// the text banner and a typed destination.
import type { Lang } from './i18n';

export const SPEECH_LANG: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN' };

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
}

let voicesCache: SpeechSynthesisVoice[] = [];
function loadVoices(): void {
  if (!ttsSupported()) return;
  voicesCache = window.speechSynthesis.getVoices();
}
if (ttsSupported()) {
  loadVoices();
  // Chrome fills the list asynchronously.
  window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

/** Best voice for the language: exact region first (hi-IN / en-IN), then any voice of that language. */
export function pickVoice(lang: Lang): SpeechSynthesisVoice | null {
  if (voicesCache.length === 0) loadVoices();
  const want = SPEECH_LANG[lang].toLowerCase();
  const base = lang;
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-');
  return (
    voicesCache.find((v) => norm(v) === want) ??
    voicesCache.find((v) => norm(v).startsWith(base)) ??
    null
  );
}

export interface SpeakOptions {
  /** Cancel whatever is being said or queued first (a new step supersedes the old one). */
  interrupt?: boolean;
  rate?: number;
  onEnd?: () => void;
}

/** Queue an utterance; no-op when speech synthesis is missing. */
export function speak(text: string, lang: Lang, opts: SpeakOptions = {}): void {
  if (!ttsSupported() || !text.trim()) {
    opts.onEnd?.();
    return;
  }
  const synth = window.speechSynthesis;
  if (opts.interrupt) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = SPEECH_LANG[lang];
  const voice = pickVoice(lang);
  if (voice) u.voice = voice;
  u.rate = opts.rate ?? 1;
  if (opts.onEnd) {
    u.onend = opts.onEnd;
    u.onerror = opts.onEnd;
  }
  synth.speak(u);
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

// ---------- Recognition ----------

/** Minimal typing of the (prefixed) SpeechRecognition constructor; lib.dom does not declare it. */
interface RecognitionResultEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}
interface RecognitionErrorEvent extends Event {
  error: string;
}
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Running inside the native Capacitor shell (iOS/Android app) rather than a browser. */
export function isNativeApp(): boolean {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  return typeof w.Capacitor?.isNativePlatform === 'function' && w.Capacitor.isNativePlatform();
}

export function sttSupported(): boolean {
  // WKWebView has no SpeechRecognition; the native shell provides it through the
  // @capacitor-community/speech-recognition plugin (Apple Speech framework).
  return isNativeApp() || recognitionCtor() !== null;
}

export type RecognitionErrorKind = 'denied' | 'no-speech' | 'network' | 'aborted' | 'other';

export interface RecognizerHandlers {
  /** Final transcript of one utterance (lower-cased, trimmed). */
  onResult: (text: string) => void;
  /** Interim text while the user is still speaking (may be empty). */
  onInterim?: (text: string) => void;
  onError?: (kind: RecognitionErrorKind) => void;
  onEnd?: () => void;
  onStart?: () => void;
}

export interface Recognizer {
  start: () => void;
  stop: () => void;
  /** Stop and drop every pending callback (component unmount). */
  dispose: () => void;
}

function classify(err: string): RecognitionErrorKind {
  if (err === 'not-allowed' || err === 'service-not-allowed') return 'denied';
  if (err === 'no-speech') return 'no-speech';
  if (err === 'network') return 'network';
  if (err === 'aborted') return 'aborted';
  return 'other';
}

/** Native one-shot recogniser (Capacitor shell): Apple Speech on iOS. Same handler contract. */
function createNativeRecognizer(lang: Lang, handlers: RecognizerHandlers): Recognizer {
  let disposed = false;
  let busy = false;
  const run = async () => {
    if (disposed || busy) return;
    busy = true;
    try {
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
      const avail = await SpeechRecognition.available();
      if (!avail.available) {
        handlers.onError?.('other');
        return;
      }
      const perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== 'granted') {
        handlers.onError?.('denied');
        return;
      }
      handlers.onStart?.();
      const partial = await SpeechRecognition.addListener('partialResults', (ev: { matches?: string[] }) => {
        if (!disposed && ev.matches?.length) handlers.onInterim?.(ev.matches[0].trim());
      });
      try {
        const res = await SpeechRecognition.start({ language: SPEECH_LANG[lang], maxResults: 1, partialResults: true, popup: false });
        const text = (res?.matches?.[0] ?? '').trim().toLowerCase();
        if (!disposed) {
          if (text) handlers.onResult(text);
          else handlers.onError?.('no-speech');
        }
      } finally {
        await partial.remove();
      }
    } catch (err) {
      if (!disposed) handlers.onError?.(classify(String((err as Error)?.message ?? err)));
    } finally {
      busy = false;
      if (!disposed) handlers.onEnd?.();
    }
  };
  const stop = () => {
    void import('@capacitor-community/speech-recognition').then(({ SpeechRecognition }) => SpeechRecognition.stop()).catch(() => undefined);
  };
  return {
    start: () => {
      void run();
    },
    stop,
    dispose: () => {
      disposed = true;
      stop();
    },
  };
}

/** One-shot recogniser: listens for a single utterance, then ends. Call `start()` again for the next one. */
export function createRecognizer(lang: Lang, handlers: RecognizerHandlers): Recognizer | null {
  if (isNativeApp()) return createNativeRecognizer(lang, handlers);
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  let rec: Recognition | null = null;
  let disposed = false;
  const build = () => {
    const r = new Ctor();
    r.lang = SPEECH_LANG[lang];
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => {
      if (!disposed) handlers.onStart?.();
    };
    r.onresult = (e) => {
      if (disposed) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript ?? '';
        if (res.isFinal) {
          handlers.onResult(text.trim().toLowerCase());
          return;
        }
        interim += text;
      }
      handlers.onInterim?.(interim.trim());
    };
    r.onerror = (e) => {
      if (!disposed) handlers.onError?.(classify(e.error));
    };
    r.onend = () => {
      if (!disposed) handlers.onEnd?.();
    };
    return r;
  };
  return {
    start: () => {
      if (disposed) return;
      try {
        rec?.abort();
      } catch {
        /* ignore */
      }
      rec = build();
      try {
        rec.start();
      } catch (err) {
        handlers.onError?.('other');
        console.warn('[speech]', err);
      }
    },
    stop: () => {
      try {
        rec?.stop();
      } catch {
        /* ignore */
      }
    },
    dispose: () => {
      disposed = true;
      try {
        rec?.abort();
      } catch {
        /* ignore */
      }
      rec = null;
    },
  };
}

/** Yes / no / repeat / where / stop in English and Hindi, matched on the recognised text. */
export type VoiceCommand = 'yes' | 'no' | 'repeat' | 'where' | 'stop' | 'demo';

const COMMANDS: Record<VoiceCommand, RegExp> = {
  yes: /\b(yes|yeah|yep|ok|okay|go|start|haan|हाँ|हां|जी|ठीक|चलो|शुरू)\b/i,
  no: /\b(no|nope|cancel|nahi|nahin|नहीं|रद्द)\b/i,
  repeat: /\b(repeat|again|dobara|dohrao|फिर|दोबारा|दोहराओ|दोहराएँ|दोहराएं)\b/i,
  where: /\b(where|kahan|कहाँ|कहां|location|स्थान)\b/i,
  stop: /\b(stop|end|quit|band|ruko|रुको|बंद|समाप्त|खत्म)\b/i,
  demo: /\b(demo|riya|रिया|डेमो)\b/i,
};

export function parseCommand(text: string): VoiceCommand | null {
  for (const key of Object.keys(COMMANDS) as VoiceCommand[]) {
    if (COMMANDS[key].test(text)) return key;
  }
  return null;
}
