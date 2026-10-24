// Listen mode (blind / low-vision travellers). The whole screen is a
// conversation: SAMAAN speaks, then listens again by itself (hands-free loop),
// so a traveller never has to find a button. Say a destination -> /search ->
// the top result is read back -> "yes" -> navigation starts; while walking:
// "repeat", "where am I", "report", "help", "stop". A single tap anywhere on the
// screen opens the microphone, a double tap repeats the current step. Every
// prompt is also on screen in an assertive live region; a typed destination and
// buttons remain for keyboard users and browsers without speech.
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedName, reportApi, routeApi, voiceApi, type ReportClassId, type ReportItem, type SearchResult, type VoiceConfig } from '../api';
import { formatDistance } from '../geo';
import type { Lang } from '../i18n';
import { Icon } from '../icons';
import type { NavigationApi } from '../navigation';
import { type PlannerPoint, type RoutePlannerApi } from '../routePlanner';
import type { Sensors } from '../sensors';
import { createRecognizer, parseBarrierClass, parseCommand, speak, sttSupported, stopSpeaking, ttsSupported, type Recognizer } from '../speech';
import { useUser } from '../user';
import { describeError, startVoiceAgent, type VoiceAgent } from '../vapi';
import { stepInstruction, stepStreet, useAnnouncer } from './useAnnouncer';

type Phase = 'idle' | 'listening' | 'thinking' | 'confirm' | 'routing' | 'navigating' | 'reportClass' | 'reportConfirm' | 'reporting';

interface Turn {
  who: 'you' | 'samaan';
  text: string;
  id: number;
}

interface ListenScreenProps {
  nav: NavigationApi;
  planner: RoutePlannerApi;
  sensors: Sensors;
  lang: Lang;
  /** Resolve the origin (GPS) and route to `to`; navigation starts automatically when the routes arrive. */
  onRoute: (to: PlannerPoint) => Promise<'ok' | 'geoDenied' | 'geoUnavailable'>;
  onDemo: () => void;
  onEnd: () => void;
  onReport: () => void;
  onHome: () => void;
  /** A report created by voice (no photo): the app adds it to the pending markers. */
  onReported: (rep: ReportItem) => void;
  /** Arrived from onboarding: greet and start listening without a tap. */
  autoGreet: boolean;
  headingRef: RefObject<HTMLElement>;
}

const MAX_SILENT_ROUNDS = 2;
const DOUBLE_TAP_MS = 400;

export default function ListenScreen({ nav, planner, sensors, lang, onRoute, onDemo, onEnd, onReport, onHome, onReported, autoGreet, headingRef }: ListenScreenProps) {
  const { t } = useTranslation();
  const user = useUser();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [interim, setInterim] = useState('');
  const [candidate, setCandidate] = useState<SearchResult | null>(null);
  const [reportClass, setReportClass] = useState<ReportClassId | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [typed, setTyped] = useState('');
  const [showTyping, setShowTyping] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [micDetail, setMicDetail] = useState<string | null>(null);
  const [handsFree, setHandsFree] = useState(true);
  const recRef = useRef<Recognizer | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const candidateRef = useRef<SearchResult | null>(null);
  candidateRef.current = candidate;
  const reportClassRef = useRef<ReportClassId | null>(null);
  reportClassRef.current = reportClass;
  const handsFreeRef = useRef(true);
  handsFreeRef.current = handsFree;
  const silentRef = useRef(0);
  const turnIdRef = useRef(0);
  const lastTapRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  // ---- Live voice agent (Vapi) when the server has a key; otherwise on-device speech ----
  const [voiceCfg, setVoiceCfg] = useState<VoiceConfig | null>(null);
  const agentRef = useRef<VoiceAgent | null>(null);
  const [callState, setCallState] = useState<'off' | 'connecting' | 'on'>('off');
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const useAgent = Boolean(voiceCfg?.enabled && voiceCfg.public_key) && !callError;
  const callOn = callState === 'on';
  useEffect(() => {
    const ac = new AbortController();
    voiceApi
      .config(ac.signal)
      .then((c) => {
        if (!ac.signal.aborted) setVoiceCfg(c);
      })
      .catch(() => {
        if (!ac.signal.aborted) setVoiceCfg({ enabled: false, provider: null, public_key: null, tools: [] });
      });
    return () => ac.abort();
  }, []);
  const { liveText, compose } = useAnnouncer(nav, lang, callOn);
  const stt = sttSupported();
  const tts = ttsSupported();
  const session = nav.state.session;

  useEffect(() => {
    const id = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [headingRef]);

  const pushTurn = useCallback((who: Turn['who'], text: string) => {
    turnIdRef.current += 1;
    const id = turnIdRef.current;
    setTurns((list) => [...list.slice(-5), { who, text, id }]);
  }, []);

  /** Speak and show a prompt; `then` runs when speech ends (or at once without TTS). */
  const say = useCallback(
    (text: string, then?: () => void) => {
      setMessage(text);
      pushTurn('samaan', text);
      if (tts) speak(text, lang, { interrupt: true, onEnd: then });
      else then?.();
    },
    [lang, tts, pushTurn],
  );

  const listen = useCallback(() => {
    if (!recRef.current) return;
    setMicError(null);
    setInterim('');
    recRef.current.start();
  }, []);

  /** Hands-free: listen again after SAMAAN spoke, unless the traveller went quiet twice in a row. */
  const listenAgain = useCallback(() => {
    if (!handsFreeRef.current || !recRef.current) return;
    if (silentRef.current >= MAX_SILENT_ROUNDS) return;
    listen();
  }, [listen]);

  const sayAndListen = useCallback((text: string) => say(text, listenAgain), [say, listenAgain]);

  const sayWhere = useCallback(() => {
    const step = nav.state.currentStep;
    const d = formatDistance(nav.state.distanceToStep);
    say(
      t('listen.say.where', {
        street: stepStreet(step, lang) ?? t('listen.say.unknownStreet'),
        distance: `${d.value} ${t(`units.${d.unit}`)}`,
        instruction: stepInstruction(step, lang),
      }),
    );
  }, [nav.state.currentStep, nav.state.distanceToStep, say, t, lang]);

  const sayHelp = useCallback(() => {
    sayAndListen(nav.state.session ? t('listen.say.helpNav') : t('listen.say.helpIdle'));
  }, [sayAndListen, nav.state.session, t]);

  const goTo = useCallback(
    async (r: SearchResult) => {
      setPhase('routing');
      say(t('listen.say.routing', { name: localizedName(r, lang) }));
      const res = await onRoute({ lat: r.lat, lon: r.lon, label: localizedName(r, lang) });
      if (res !== 'ok') {
        setPhase('idle');
        sayAndListen(t(`home.errors.${res}`) + ' ' + t('listen.say.tryDemo'));
      }
    },
    [onRoute, say, sayAndListen, t, lang],
  );

  // ---- Voice report: class -> confirm -> POST /reports without a photo ----
  const startReport = useCallback(() => {
    setPhase('reportClass');
    setReportClass(null);
    sayAndListen(t('listen.say.reportAsk'));
  }, [sayAndListen, t]);

  const sendReport = useCallback(async () => {
    const cls = reportClassRef.current ?? 'fixed_obstacle';
    const fix = sensors.fixRef.current ?? (nav.state.position && !nav.state.position.simulated ? { lat: nav.state.position.lat, lon: nav.state.position.lon } : null);
    if (!user) {
      setPhase('idle');
      sayAndListen(t('report.errors.noUser'));
      return;
    }
    if (!fix) {
      setPhase('idle');
      sayAndListen(t('listen.say.reportNoGps'));
      return;
    }
    setPhase('reporting');
    say(t('listen.say.reportSending'));
    try {
      const rep = await reportApi.create({
        photo: null,
        user_id: user.id,
        class_id: cls,
        severity: 3,
        note: t('listen.say.reportNote'),
        lat: fix.lat,
        lon: fix.lon,
        device_lat: fix.lat,
        device_lon: fix.lon,
        kind: 'barrier',
      });
      onReported(rep);
      setPhase(nav.state.session ? 'navigating' : 'idle');
      sayAndListen(t('listen.say.reportSent'));
    } catch (err) {
      console.warn('[voice report]', err);
      setPhase(nav.state.session ? 'navigating' : 'idle');
      sayAndListen(t('listen.say.reportFailed'));
    }
  }, [sensors.fixRef, nav.state.position, nav.state.session, user, say, sayAndListen, t, onReported]);

  const handleText = useCallback(
    (raw: string) => {
      const text = raw.trim().toLowerCase();
      if (!text) return;
      silentRef.current = 0;
      pushTurn('you', text);
      const cmd = parseCommand(text);
      const p = phaseRef.current;

      // Report dialogue first: it can run before or during a trip.
      if (p === 'reportClass') {
        if (cmd === 'no' || cmd === 'stop') {
          setPhase(nav.state.session ? 'navigating' : 'idle');
          sayAndListen(t('listen.say.cancelled'));
          return;
        }
        const cls = (parseBarrierClass(text) as ReportClassId | null) ?? 'fixed_obstacle';
        setReportClass(cls);
        setPhase('reportConfirm');
        sayAndListen(t('listen.say.reportConfirm', { name: t(`barrierClass.${cls}`) }));
        return;
      }
      if (p === 'reportConfirm') {
        if (cmd === 'yes') void sendReport();
        else if (cmd === 'no' || cmd === 'stop') {
          setPhase(nav.state.session ? 'navigating' : 'idle');
          sayAndListen(t('listen.say.cancelled'));
        } else sayAndListen(t('listen.say.sayYesOrNo'));
        return;
      }
      if (cmd === 'help') {
        sayHelp();
        return;
      }
      if (cmd === 'report') {
        startReport();
        return;
      }
      if (nav.state.session) {
        if (cmd === 'repeat') nav.repeat();
        else if (cmd === 'where') sayWhere();
        else if (cmd === 'stop') {
          onEnd();
          setPhase('idle');
          sayAndListen(t('listen.say.stopped'));
        } else if (cmd === 'home') {
          onEnd();
          onHome();
        } else sayAndListen(t('listen.say.unknownCommand'));
        return;
      }
      if (p === 'confirm' && candidateRef.current) {
        if (cmd === 'yes') void goTo(candidateRef.current);
        else if (cmd === 'no') {
          setCandidate(null);
          setPhase('idle');
          sayAndListen(t('listen.say.whereTo'));
        } else sayAndListen(t('listen.say.sayYesOrNo'));
        return;
      }
      if (cmd === 'demo') {
        setPhase('routing');
        say(t('listen.say.demoStarting'));
        onDemo();
        return;
      }
      if (cmd === 'home') {
        onHome();
        return;
      }
      if (cmd === 'stop' || cmd === 'no') {
        setPhase('idle');
        say(t('listen.say.cancelled'));
        return;
      }
      // Anything else is a destination name.
      setPhase('thinking');
      searchAbortRef.current?.abort();
      const ac = new AbortController();
      searchAbortRef.current = ac;
      routeApi
        .search(text, 1, ac.signal)
        .then((res) => {
          if (ac.signal.aborted) return;
          const top = res.results[0];
          if (top) {
            setCandidate(top);
            setPhase('confirm');
            sayAndListen(t('listen.say.found', { name: localizedName(top, lang) }));
          } else {
            setPhase('idle');
            sayAndListen(t('listen.say.notFound', { query: text }));
          }
        })
        .catch(() => {
          if (ac.signal.aborted) return;
          setPhase('idle');
          sayAndListen(t('listen.say.searchFailed'));
        });
    },
    [nav, sayWhere, sayHelp, startReport, sendReport, onEnd, onHome, say, sayAndListen, t, goTo, onDemo, lang, pushTurn],
  );
  const handleTextRef = useRef(handleText);
  handleTextRef.current = handleText;

  // One recogniser for the screen's lifetime (rebuilt when the language changes).
  useEffect(() => {
    const rec = createRecognizer(lang, {
      onStart: () => {
        setPhase((p) => (p === 'idle' || p === 'navigating' ? 'listening' : p));
      },
      onInterim: (text) => setInterim(text),
      onResult: (text) => {
        setInterim('');
        handleTextRef.current(text);
      },
      onError: (kind, detail) => {
        if (kind === 'aborted') return;
        setMicDetail(detail ?? null);
        if (kind === 'no-speech') {
          silentRef.current += 1;
          if (silentRef.current >= MAX_SILENT_ROUNDS) setMessage(t('listen.say.tapWhenReady'));
          setPhase((p) => (p === 'listening' ? (nav.state.session ? 'navigating' : 'idle') : p));
          return;
        }
        setMicError(kind);
        setPhase((p) => (p === 'listening' ? (nav.state.session ? 'navigating' : 'idle') : p));
      },
      onEnd: () => {
        setPhase((p) => (p === 'listening' ? (nav.state.session ? 'navigating' : 'idle') : p));
      },
    });
    recRef.current = rec;
    return () => {
      rec?.dispose();
      recRef.current = null;
      searchAbortRef.current?.abort();
      stopSpeaking();
    };
    // nav.state.session is read through the ref-like closure only to pick the resting phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // While in a call the assistant voices the navigation announcements and gets them as context.
  const announcement = nav.state.announcement;
  useEffect(() => {
    const agent = agentRef.current;
    if (!agent || !callOn || !announcement) return;
    const text = compose(announcement);
    if (!text) return;
    agent.say(text);
    const street = stepStreet(announcement.step, lang) ?? '';
    agent.addContext(`Navigation context: ${text}${street ? ` Street: ${street}.` : ''} Remaining ${Math.round(nav.state.remainingM)} m.`);
    // compose/nav.state change every tick; the announcement id is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcement?.id, callOn]);
  useEffect(() => {
    if (!callOn) return;
    const push = () => {
      const f = sensors.fixRef.current;
      if (f) agentRef.current?.addContext(`Traveller location: lat ${f.lat.toFixed(6)}, lon ${f.lon.toFixed(6)}, accuracy ${Math.round(f.accuracy)} m.`);
    };
    push();
    const id = window.setInterval(push, 20000);
    return () => window.clearInterval(id);
  }, [callOn, sensors.fixRef]);

  const onToolCall = useCallback(
    (name: string, args: Record<string, unknown>) => {
      if (name === 'start_navigation') {
        const lat = Number(args.lat);
        const lon = Number(args.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          setPhase('routing');
          void onRoute({ lat, lon, label: String(args.name ?? '') }).then((res) => {
            if (res !== 'ok') {
              setPhase('idle');
              agentRef.current?.addContext(`Navigation could not start: ${res === 'geoDenied' ? 'location permission denied' : 'location unavailable'}. Tell the traveller in one sentence.`);
            }
          });
        }
      } else if (name === 'stop_navigation') {
        onEnd();
        setPhase('idle');
      } else if (name === 'repeat_step') {
        nav.repeat();
      } else if (name === 'report_barrier') {
        pushTurn('samaan', t('listen.say.reportSending'));
      }
    },
    [onRoute, onEnd, nav, pushTurn, t],
  );
  const onToolCallRef = useRef(onToolCall);
  onToolCallRef.current = onToolCall;

  const endCall = useCallback(() => {
    agentRef.current?.stop();
    agentRef.current = null;
    setCallState('off');
    setAssistantSpeaking(false);
  }, []);

  const startCall = useCallback(async () => {
    if (!voiceCfg?.public_key || agentRef.current) return;
    stopSpeaking();
    recRef.current?.stop();
    setCallError(null);
    setCallState('connecting');
    setMessage(t('listen.callConnecting'));
    const f = sensors.fixRef.current;
    try {
      const agent = await startVoiceAgent(
        { publicKey: voiceCfg.public_key, assistantId: voiceCfg.assistant_id ?? null, lang, userId: user?.id ?? null, profile: user?.profile ?? 'blind_low_vision', lat: f?.lat ?? null, lon: f?.lon ?? null, greeting: t('listen.say.greeting') },
        {
          onCallStart: () => {
            setCallState('on');
            setMessage(t('listen.say.greeting'));
          },
          onCallEnd: () => {
            agentRef.current = null;
            setCallState('off');
            setAssistantSpeaking(false);
          },
          onSpeaking: setAssistantSpeaking,
          onTranscript: (role, text, final) => {
            if (!final) {
              if (role === 'user') setInterim(text);
              return;
            }
            setInterim('');
            if (role === 'assistant') setMessage(text);
            pushTurn(role === 'user' ? 'you' : 'samaan', text);
          },
          onToolCall: (name, args) => onToolCallRef.current(name, args),
          onError: (msg) => {
            console.warn('[vapi]', msg);
            setCallError(msg);
            agentRef.current = null;
            setCallState('off');
            setMessage(t('listen.callError', { message: msg }));
          },
        },
      );
      agentRef.current = agent;
    } catch (err) {
      const msg = describeError(err);
      console.warn('[vapi start]', err);
      setCallError(msg);
      setCallState('off');
      setMessage(t('listen.callError', { message: msg }));
    }
  }, [voiceCfg, lang, user, sensors.fixRef, t, pushTurn]);
  useEffect(() => () => agentRef.current?.stop(), []);

  // Greeting on arrival from onboarding (or when Listen is the chosen mode): speak, then listen.
  const greetedRef = useRef(false);
  useEffect(() => {
    if (!autoGreet || greetedRef.current || session || voiceCfg === null) return;
    greetedRef.current = true;
    const id = window.setTimeout(() => {
      if (useAgent) void startCall();
      else sayAndListen(t('listen.say.greeting'));
    }, 300);
    return () => window.clearTimeout(id);
  }, [autoGreet, session, sayAndListen, t, voiceCfg, useAgent, startCall]);

  // Routing outcome: the engine took over, or the planner reported an error.
  useEffect(() => {
    if (session) {
      setPhase('navigating');
      silentRef.current = 0;
    } else setPhase((p) => (p === 'navigating' ? 'idle' : p));
  }, [session]);
  const plannerError = planner.state.error;
  useEffect(() => {
    if (plannerError && phaseRef.current === 'routing') {
      setPhase('idle');
      sayAndListen(t(`route.errors.${plannerError}`));
    }
  }, [plannerError, sayAndListen, t]);

  const toggleListening = useCallback(() => {
    if (useAgent) {
      if (callState === 'off') void startCall();
      else endCall();
      return;
    }
    if (!stt) return;
    silentRef.current = 0;
    if (phase === 'listening') {
      recRef.current?.stop();
      setPhase(session ? 'navigating' : 'idle');
      return;
    }
    stopSpeaking();
    if (!session && phase === 'idle' && !message) setMessage(t('listen.say.whereTo'));
    listen();
  }, [stt, phase, session, message, listen, t, useAgent, callState, startCall, endCall]);

  // Whole-screen gestures: single tap = talk, double tap = repeat the step (while navigating).
  const onScreenClick = (e: MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, form, label')) return;
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      if (session) nav.repeat();
      return;
    }
    lastTapRef.current = now;
    window.setTimeout(() => {
      if (lastTapRef.current === now) toggleListening();
    }, DOUBLE_TAP_MS);
  };

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const text = typed;
    setTyped('');
    handleText(text);
  };

  const orbLabel = useAgent
    ? callState === 'connecting'
      ? t('listen.callConnecting')
      : callState === 'on'
        ? assistantSpeaking
          ? t('listen.assistantSpeaking')
          : t('listen.callOn')
        : t('listen.startCall')
    : !stt
    ? t('listen.noStt')
    : phase === 'listening'
      ? t('listen.listening')
      : phase === 'thinking' || phase === 'routing' || phase === 'reporting'
        ? t('listen.thinking')
        : session
          ? t('listen.tapCommand')
          : phase === 'confirm' || phase === 'reportConfirm'
            ? t('listen.tapAnswer')
            : phase === 'reportClass'
              ? t('listen.tapClass')
              : t('listen.tapToSpeak');

  const step = nav.state.currentStep;
  const d = formatDistance(nav.state.distanceToStep);
  const busy = phase === 'thinking' || phase === 'routing' || phase === 'reporting';

  return (
    <section className={`listen listen--dark${phase === 'listening' ? ' listen--on' : ''}`} aria-labelledby="listen-title" onClick={onScreenClick}>
      <header className="listen__top">
        <h2 id="listen-title" className="listen__title" ref={headingRef as RefObject<HTMLHeadingElement>} tabIndex={-1}>
          <Icon name="mic" size={22} /> {t('mode.listen.title')}
        </h2>
        <div className="listen__topBtns">
          {useAgent ? (
            callState !== 'off' && (
              <button type="button" className="btn btn--small btn--onDark" onClick={endCall}>
                {t('listen.endCall')}
              </button>
            )
          ) : (
            <button type="button" className="btn btn--small btn--onDark" aria-pressed={handsFree} onClick={() => setHandsFree((v) => !v)}>
              {handsFree ? t('listen.handsFreeOn') : t('listen.handsFreeOff')}
            </button>
          )}
          <button type="button" className="btn btn--small btn--onDark" onClick={onHome}>
            {t('tabs.home')}
          </button>
        </div>
      </header>
      {useAgent && (
        <p className="listen__agentchip">
          <span className={`listen__agentdot${callOn ? ' listen__agentdot--on' : ''}`} aria-hidden="true" /> {t('listen.voiceAgent')}
        </p>
      )}
      {!useAgent && (!stt || !tts) && (
        <p className="listen__nosupport" role="alert">
          {!stt && !tts ? t('listen.noSpeech') : !stt ? t('listen.noSttLong') : t('listen.noTtsLong')}
        </p>
      )}

      <div className="listen__stage">
        <button
          type="button"
          className={`listen__orb${phase === 'listening' || (callOn && !assistantSpeaking) ? ' listen__orb--on' : ''}${busy || callState === 'connecting' || assistantSpeaking ? ' listen__orb--busy' : ''}`}
          aria-pressed={phase === 'listening' || callOn}
          onClick={toggleListening}
          disabled={!useAgent && !stt}
        >
          <span className="listen__ring" aria-hidden="true" />
          <span className="listen__ring listen__ring--2" aria-hidden="true" />
          <Icon name="mic" size={56} />
        </button>
        <p className="listen__orbLabel">{orbLabel}</p>
      </div>

      <div className="listen__panel" lang={lang}>
        <p className="listen__message" aria-live="assertive" aria-atomic="true">
          {session && liveText && phase !== 'reportClass' && phase !== 'reportConfirm' ? liveText : message}
        </p>
        {interim && <p className="listen__interim">{t('listen.heard', { text: interim })}</p>}
        {micError && (
          <p className="listen__error" role="alert">
            {t(`listen.micError.${micError}`)}
            {micDetail && <span className="listen__errorDetail"> ({micDetail})</span>}
          </p>
        )}
        {session && step && (
          <p className="listen__step">
            {d.value} {t(`units.${d.unit}`)} · {stepInstruction(step, lang)}
          </p>
        )}
      </div>

      {turns.length > 1 && (
        <ol className="listen__turns" aria-label={t('listen.transcript')}>
          {turns.slice(0, -1).map((tr) => (
            <li key={tr.id} className={`listen__turn listen__turn--${tr.who}`}>
              <span className="listen__who">{tr.who === 'you' ? t('listen.you') : t('app.name')}</span> {tr.text}
            </li>
          ))}
        </ol>
      )}

      {!session && phase === 'confirm' && candidate && (
        <div className="listen__confirm" role="group" aria-label={t('listen.confirmLabel')}>
          <button type="button" className="btn btn--primary btn--big" onClick={() => handleText('yes')}>
            {t('listen.yes', { name: localizedName(candidate, lang) })}
          </button>
          <button type="button" className="btn btn--big btn--onDark" onClick={() => handleText('no')}>
            {t('listen.no')}
          </button>
        </div>
      )}
      {phase === 'reportConfirm' && reportClass && (
        <div className="listen__confirm" role="group" aria-label={t('listen.confirmLabel')}>
          <button type="button" className="btn btn--primary btn--big" onClick={() => handleText('yes')}>
            {t('listen.sendReport', { name: t(`barrierClass.${reportClass}`) })}
          </button>
          <button type="button" className="btn btn--big btn--onDark" onClick={() => handleText('no')}>
            {t('listen.noCancel')}
          </button>
        </div>
      )}

      <div className="listen__cmds" role="group" aria-label={t('listen.commandsLabel')}>
        {session ? (
          <>
            <button type="button" className="btn btn--onDark" onClick={() => nav.repeat()}>
              {t('listen.cmd.repeat')}
            </button>
            <button type="button" className="btn btn--onDark" onClick={sayWhere}>
              {t('listen.cmd.where')}
            </button>
            <button type="button" className="btn btn--onDark" onClick={startReport}>
              {t('listen.cmd.report')}
            </button>
            {nav.state.needsSimulation && !nav.state.simulating && (
              <button type="button" className="btn btn--primary" onClick={nav.startSimulation}>
                {t('nav.simulate')}
              </button>
            )}
            {nav.state.simulating && (
              <button type="button" className="btn btn--onDark" onClick={nav.stopSimulation}>
                {t('nav.simStop')}
              </button>
            )}
            <button
              type="button"
              className="btn btn--onDark listen__stop"
              onClick={() => {
                onEnd();
                say(t('listen.say.stopped'));
              }}
            >
              {t('listen.cmd.stop')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--onDark" onClick={sayHelp}>
              {t('listen.cmd.help')}
            </button>
            <button type="button" className="btn btn--onDark" onClick={startReport}>
              {t('listen.cmd.report')}
            </button>
            <button type="button" className="btn btn--onDark" onClick={() => handleText('demo')}>
              {t('home.demo')}
            </button>
            <button type="button" className="btn btn--onDark" onClick={() => setShowTyping((v) => !v)} aria-expanded={showTyping}>
              {t('listen.typeInstead')}
            </button>
          </>
        )}
      </div>

      {!session && showTyping && (
        <form className="listen__form" onSubmit={submitTyped}>
          <label className="field__label" htmlFor="listen-typed">
            {t('listen.typeDestination')}
          </label>
          <div className="place__row">
            <input id="listen-typed" className="place__input" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" enterKeyHint="go" />
            <button type="submit" className="btn btn--primary" disabled={!typed.trim() || busy}>
              {t('listen.find')}
            </button>
          </div>
          <button type="button" className="btn btn--onDark" onClick={onReport}>
            {t('report.fab')}
          </button>
        </form>
      )}
      <p className="listen__help">{t('listen.help')}</p>
    </section>
  );
}
