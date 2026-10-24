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
import { localizedName, reportApi, routeApi, voiceApi, type ReportClassId, type ReportItem, type SearchResult, type VoiceConfig, type VoiceTurn } from '../api';
import { formatDistance } from '../geo';
import type { Lang } from '../i18n';
import { Icon } from '../icons';
import type { NavigationApi } from '../navigation';
import { type PlannerPoint, type RoutePlannerApi } from '../routePlanner';
import type { Sensors } from '../sensors';
import { createRecognizer, parseBarrierClass, parseCommand, speak, sttSupported, stopSpeaking, ttsSupported, type Recognizer } from '../speech';
import { useUser } from '../user';
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

/** 'nvidia/nemotron-3.5-lightning-30b-a3b' -> 'Nemotron 3.5 Lightning' for the chip. */
function shortModel(id: string | null | undefined): string {
  if (!id) return 'NVIDIA';
  const tail = id.split('/').pop() ?? id;
  return tail
    .replace(/-\d+b(-a\d+b)?$/i, '')
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
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
  // ---- Conversation model (NVIDIA, via POST /voice/chat) when the server has a key; rules otherwise ----
  const [voiceCfg, setVoiceCfg] = useState<VoiceConfig | null>(null);
  const [modelDown, setModelDown] = useState<string | null>(null);
  const useAgent = Boolean(voiceCfg?.enabled) && !modelDown;
  const chatRef = useRef<VoiceTurn[]>([]);
  const chatAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    voiceApi
      .config(ac.signal)
      .then((c) => {
        if (!ac.signal.aborted) setVoiceCfg(c);
      })
      .catch(() => {
        if (!ac.signal.aborted) setVoiceCfg({ enabled: false, provider: null, model: null, tools: [] });
      });
    return () => ac.abort();
  }, []);
  const { liveText } = useAnnouncer(nav, lang, false);
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

  const handleRules = useCallback(
    (text: string) => {
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
    [nav, sayWhere, sayHelp, startReport, sendReport, onEnd, onHome, say, sayAndListen, t, goTo, onDemo, lang],
  );
  const handleRulesRef = useRef(handleRules);
  handleRulesRef.current = handleRules;

  /** Every recognised sentence: the model when configured (rules on failure), else the rule-based dialogue. */
  const handleText = useCallback(
    (raw: string) => {
      const text = raw.trim().toLowerCase();
      if (!text) return;
      silentRef.current = 0;
      pushTurn('you', text);
      const p = phaseRef.current;
      const inRuleDialogue = p === 'reportClass' || p === 'reportConfirm' || p === 'confirm';
      const cmd = parseCommand(text);
      // Local shortcuts stay instant even with the model: demo, home, repeat while walking.
      if (cmd === 'demo' || cmd === 'home' || (cmd === 'repeat' && nav.state.session)) {
        handleRulesRef.current(text);
        return;
      }
      if (useAgent && !inRuleDialogue) {
        void askModelRef.current(text).then((handled) => {
          if (!handled) handleRulesRef.current(text);
        });
        return;
      }
      handleRulesRef.current(text);
    },
    [pushTurn, useAgent, nav.state.session],
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

  /** Context the model needs for "where am I" and reports: current step, street, remaining distance. */
  const navContext = useCallback((): string | null => {
    const st = nav.state;
    if (!st.session) return null;
    const step = st.currentStep;
    const d = formatDistance(st.distanceToStep);
    const street = stepStreet(step, lang);
    const parts = [`in ${d.value} ${t(`units.${d.unit}`)}: ${stepInstruction(step, lang)}`];
    if (street) parts.push(`street: ${street}`);
    parts.push(`remaining ${Math.round(st.remainingM)} m`);
    if (st.arrived) parts.push('arrived at the destination');
    return parts.join('; ');
  }, [nav.state, lang, t]);

  /** Send one recognised sentence to the model; apply its actions; speak its reply; listen again. */
  const askModel = useCallback(
    async (text: string): Promise<boolean> => {
      chatAbortRef.current?.abort();
      const ac = new AbortController();
      chatAbortRef.current = ac;
      const history = [...chatRef.current.slice(-11), { role: 'user' as const, content: text }];
      const fix = sensors.fixRef.current;
      setPhase('thinking');
      try {
        const res = await voiceApi.chat(
          {
            messages: history,
            lang,
            user_id: user?.id ?? null,
            location: fix ? { lat: fix.lat, lon: fix.lon, accuracy_m: fix.accuracy } : null,
            nav_context: navContext(),
            navigating: Boolean(nav.state.session),
          },
          ac.signal,
        );
        if (ac.signal.aborted) return true;
        chatRef.current = [...history, { role: 'assistant', content: res.memory ?? res.reply }];
        let routing = false;
        for (const a of res.actions) {
          if (a.name === 'start_navigation') {
            const lat = Number(a.args.lat);
            const lon = Number(a.args.lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              routing = true;
              setPhase('routing');
              void onRoute({ lat, lon, label: String(a.args.name ?? '') }).then((r) => {
                if (r !== 'ok') {
                  setPhase('idle');
                  sayAndListen(t(`home.errors.${r}`) + ' ' + t('listen.say.tryDemo'));
                }
              });
            }
          } else if (a.name === 'stop_navigation') {
            onEnd();
            setPhase('idle');
          } else if (a.name === 'repeat_step') {
            nav.repeat();
          }
        }
        if (res.tool_log.some((l) => l.name === 'report_barrier' && l.result.includes('sent'))) pushTurn('samaan', t('listen.say.reportSending'));
        if (!routing) setPhase(nav.state.session ? 'navigating' : 'idle');
        if (routing) say(res.reply);
        else sayAndListen(res.reply);
        return true;
      } catch (err) {
        if (ac.signal.aborted) return true;
        console.warn('[voice chat]', err);
        setModelDown(err instanceof Error ? err.message : String(err));
        setPhase(nav.state.session ? 'navigating' : 'idle');
        return false;
      }
    },
    [lang, user, sensors.fixRef, navContext, nav, onRoute, onEnd, say, sayAndListen, pushTurn, t],
  );
  const askModelRef = useRef(askModel);
  askModelRef.current = askModel;
  useEffect(() => () => chatAbortRef.current?.abort(), []);

  // Greeting on arrival from onboarding (or when Listen is the chosen mode): speak, then listen.
  const greetedRef = useRef(false);
  useEffect(() => {
    if (!autoGreet || greetedRef.current || session) return;
    greetedRef.current = true;
    const id = window.setTimeout(() => sayAndListen(t('listen.say.greeting')), 300);
    return () => window.clearTimeout(id);
  }, [autoGreet, session, sayAndListen, t]);

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
  }, [stt, phase, session, message, listen, t]);

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

  const orbLabel = !stt
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
          <button type="button" className="btn btn--small btn--onDark" aria-pressed={handsFree} onClick={() => setHandsFree((v) => !v)}>
            {handsFree ? t('listen.handsFreeOn') : t('listen.handsFreeOff')}
          </button>
          <button type="button" className="btn btn--small btn--onDark" onClick={onHome}>
            {t('tabs.home')}
          </button>
        </div>
      </header>
      {useAgent && (
        <p className="listen__agentchip">
          <span className="listen__agentdot listen__agentdot--on" aria-hidden="true" /> {t('listen.voiceAgent', { model: shortModel(voiceCfg?.model) })}
        </p>
      )}
      {modelDown && (
        <p className="listen__agentchip">
          <span className="listen__agentdot" aria-hidden="true" /> {t('listen.modelDown')}
        </p>
      )}
      {(!stt || !tts) && (
        <p className="listen__nosupport" role="alert">
          {!stt && !tts ? t('listen.noSpeech') : !stt ? t('listen.noSttLong') : t('listen.noTtsLong')}
        </p>
      )}

      <div className="listen__stage">
        <button type="button" className={`listen__orb${phase === 'listening' ? ' listen__orb--on' : ''}${busy ? ' listen__orb--busy' : ''}`} aria-pressed={phase === 'listening'} onClick={toggleListening} disabled={!stt}>
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
