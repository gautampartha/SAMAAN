// Vapi voice agent for Listen mode. The phone opens a real-time voice call to a
// transient assistant (LLM + speech-to-text + text-to-speech on Vapi's side)
// whose tools call back into the SAMAAN API (/voice/tools). The app listens to
// the call's tool-call messages to start / stop / repeat navigation, and feeds
// the assistant navigation context and the traveller's location as system
// messages so "where am I" and reports work. The public key comes from
// GET /voice/config; nothing secret lives in the app.
import { API_URL, type Profile } from './api';
import type { Lang } from './i18n';

export interface VoiceAgentConfig {
  publicKey: string;
  lang: Lang;
  userId: number | string | null;
  profile: Profile;
  lat: number | null;
  lon: number | null;
  /** Spoken by the assistant when the call connects. */
  greeting: string;
}

export type TranscriptRole = 'user' | 'assistant';

export interface VoiceAgentHandlers {
  onCallStart?: () => void;
  onCallEnd?: () => void;
  onSpeaking?: (assistantSpeaking: boolean) => void;
  onTranscript?: (role: TranscriptRole, text: string, final: boolean) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

export interface VoiceAgent {
  stop: () => void;
  /** Make the assistant speak this text now (navigation steps, warnings). */
  say: (text: string) => void;
  /** Background facts for the assistant (location, current step). Not spoken. */
  addContext: (text: string) => void;
  setMuted: (muted: boolean) => void;
  readonly active: boolean;
}

const VOICE: Record<Lang, { provider: string; voiceId: string }> = {
  en: { provider: 'azure', voiceId: 'en-IN-NeerjaNeural' },
  hi: { provider: 'azure', voiceId: 'hi-IN-SwaraNeural' },
};
const STT_LANG: Record<Lang, string> = { en: 'en', hi: 'hi' };

const CLASS_IDS = [
  'steps_or_high_kerb',
  'parked_vehicle',
  'open_drain',
  'curb_ramp',
  'broken_surface',
  'fixed_obstacle',
  'vendor_encroachment',
  'bike_barrier',
  'construction',
  'waterlogging',
  'no_footpath',
  'footpath_end',
];

function systemPrompt(lang: Lang): string {
  const language = lang === 'hi' ? 'Hindi (Devanagari script, simple everyday words)' : 'Indian English';
  return [
    `You are SAMAAN, a calm voice guide for a blind or low-vision traveller walking on an Indian university campus. Speak ${language}.`,
    'Keep every reply to one or two short sentences. Never describe the screen. Never invent places, distances or directions.',
    'Flow: when the traveller names a place, call find_place with their words. Read back the top match in one sentence and ask "Shall I start?".',
    'If they agree, call start_navigation with that match\'s lat, lon and name, then say that directions will follow. Do not start before they agree.',
    'When they ask where they are, or what is next, answer only from the latest "Navigation context" system message; if there is none, say navigation has not started.',
    'When they say repeat, call repeat_step. When they say stop, finish, or cancel, call stop_navigation and confirm.',
    'When they want to report, complain, or say something blocks the way: ask what it is if unclear, then call report_barrier with class_id from this list: ' +
      CLASS_IDS.join(', ') +
      ' and lat, lon from the latest "Traveller location" system message. Confirm in one sentence.',
    'When they ask for help, list what they can say: a place name, where am I, repeat, report, stop, goodbye.',
    'When they say goodbye or end the call, say goodbye briefly and end the call.',
    'The traveller\'s id is {{user_id}}, language code {{lang}}, starting location lat {{lat}} lon {{lon}}.',
  ].join(' ');
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: 'function',
    async: false,
    server: { url: `${API_URL}/voice/tools`, timeoutSeconds: 20 },
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

export function assistantConfig(cfg: VoiceAgentConfig): Record<string, unknown> {
  const lat = cfg.lat === null ? '' : cfg.lat.toFixed(6);
  const lon = cfg.lon === null ? '' : cfg.lon.toFixed(6);
  return {
    name: 'SAMAAN Listen',
    firstMessage: cfg.greeting,
    firstMessageMode: 'assistant-speaks-first',
    maxDurationSeconds: 1800,
    endCallPhrases: ['goodbye', 'bye bye', 'अलविदा'],
    transcriber: { provider: 'deepgram', model: 'nova-2', language: STT_LANG[cfg.lang] },
    voice: VOICE[cfg.lang],
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'system', content: systemPrompt(cfg.lang) }],
      tools: [
        tool('find_place', 'Search a campus place by name. Returns the top match with lat and lon.', { query: { type: 'string', description: 'The place as the traveller said it' } }, ['query']),
        tool(
          'start_navigation',
          'Start spoken turn-by-turn navigation to a place found with find_place. Only after the traveller agreed.',
          { lat: { type: 'number' }, lon: { type: 'number' }, name: { type: 'string' } },
          ['lat', 'lon', 'name'],
        ),
        tool('stop_navigation', 'Stop the current navigation.', {}, []),
        tool('repeat_step', 'Repeat the current navigation instruction.', {}, []),
        tool(
          'report_barrier',
          'File a barrier report at the traveller\'s current location.',
          {
            class_id: { type: 'string', enum: CLASS_IDS },
            lat: { type: 'number' },
            lon: { type: 'number' },
            note: { type: 'string', description: 'What the traveller said, in their words' },
            user_id: { type: 'string' },
          },
          ['class_id', 'lat', 'lon'],
        ),
      ],
    },
    clientMessages: ['transcript', 'tool-calls', 'tool-calls-result', 'speech-update', 'status-update'],
    serverMessages: ['tool-calls'],
    variableValues: { user_id: cfg.userId === null ? '' : String(cfg.userId), lang: cfg.lang, lat, lon },
  };
}

interface VapiMessage {
  type?: string;
  role?: string;
  transcriptType?: string;
  transcript?: string;
  status?: string;
  toolCallList?: Array<{ id?: string; name?: string; function?: { name?: string; arguments?: unknown } }>;
  toolCalls?: Array<{ id?: string; name?: string; function?: { name?: string; arguments?: unknown } }>;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return {};
}

/** Vapi errors arrive as plain objects ({ error: { message }, errorMsg, type, … }); turn one into a sentence. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const inner = o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>) : null;
    const candidates = [o.errorMsg, o.message, inner?.message, inner?.msg, o.type, o.stage];
    const first = candidates.find((c) => typeof c === 'string' && c.trim());
    if (typeof first === 'string') return first;
    try {
      return JSON.stringify(e).slice(0, 160);
    } catch {
      /* ignore */
    }
  }
  return String(e);
}

/** Open the call. Resolves once the SDK accepted the start (the assistant greets a moment later). */
export async function startVoiceAgent(cfg: VoiceAgentConfig, handlers: VoiceAgentHandlers): Promise<VoiceAgent> {
  const { default: Vapi } = await import('@vapi-ai/web');
  const vapi = new Vapi(cfg.publicKey);
  let active = false;

  vapi.on('call-start', () => {
    active = true;
    handlers.onCallStart?.();
  });
  vapi.on('call-end', () => {
    active = false;
    handlers.onCallEnd?.();
  });
  vapi.on('speech-start', () => {
    handlers.onSpeaking?.(true);
  });
  vapi.on('speech-end', () => {
    handlers.onSpeaking?.(false);
  });
  vapi.on('error', (e: unknown) => {
    handlers.onError?.(describeError(e));
  });
  vapi.on('message', (raw: unknown) => {
    const m = (raw ?? {}) as VapiMessage;
    if (m.type === 'transcript' && typeof m.transcript === 'string') {
      const role: TranscriptRole = m.role === 'assistant' ? 'assistant' : 'user';
      handlers.onTranscript?.(role, m.transcript, m.transcriptType === 'final');
      return;
    }
    if (m.type === 'tool-calls') {
      const list = m.toolCallList ?? m.toolCalls ?? [];
      for (const c of list) {
        const name = c.function?.name ?? c.name ?? '';
        if (name) handlers.onToolCall?.(name, parseArgs(c.function?.arguments));
      }
    }
  });

  const overrides = { variableValues: (assistantConfig(cfg) as { variableValues: Record<string, string> }).variableValues };
  await vapi.start(assistantConfig(cfg) as never, overrides as never);

  return {
    stop: () => {
      try {
        vapi.stop();
      } catch {
        /* ignore */
      }
      active = false;
    },
    say: (text: string) => {
      if (!active || !text.trim()) return;
      try {
        vapi.say(text);
      } catch (err) {
        console.warn('[vapi say]', err);
      }
    },
    addContext: (text: string) => {
      if (!active) return;
      try {
        vapi.send({ type: 'add-message', message: { role: 'system', content: text } });
      } catch (err) {
        console.warn('[vapi context]', err);
      }
    },
    setMuted: (muted: boolean) => {
      try {
        vapi.setMuted(muted);
      } catch {
        /* ignore */
      }
    },
    get active() {
      return active;
    },
  };
}
