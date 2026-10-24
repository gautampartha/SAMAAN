// Listen mode (blind / low-vision travellers): one giant button toggles
// listening. Say a destination -> /search -> the top result is read back ->
// "Say yes to go" -> navigation starts; while navigating: "repeat", "where am I",
// "stop". Every prompt is also on screen in an assertive live region, and every
// step works with the keyboard: a typed destination, Yes / No, Repeat / Where /
// Stop buttons. Without the speech APIs the text banner and buttons remain.
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedName, routeApi, type SearchResult } from '../api';
import { formatDistance } from '../geo';
import type { Lang } from '../i18n';
import type { NavigationApi } from '../navigation';
import { type PlannerPoint, type RoutePlannerApi } from '../routePlanner';
import { createRecognizer, parseCommand, speak, sttSupported, stopSpeaking, ttsSupported, type Recognizer } from '../speech';
import { stepInstruction, stepStreet, useAnnouncer } from './useAnnouncer';

type Phase = 'idle' | 'listening' | 'thinking' | 'confirm' | 'routing' | 'navigating';

interface ListenScreenProps {
  nav: NavigationApi;
  planner: RoutePlannerApi;
  lang: Lang;
  /** Resolve the origin (GPS) and route to `to`; navigation starts automatically when the routes arrive. */
  onRoute: (to: PlannerPoint) => Promise<'ok' | 'geoDenied' | 'geoUnavailable'>;
  onDemo: () => void;
  onEnd: () => void;
  onReport: () => void;
  headingRef: RefObject<HTMLElement>;
}

export default function ListenScreen({ nav, planner, lang, onRoute, onDemo, onEnd, onReport, headingRef }: ListenScreenProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [interim, setInterim] = useState('');
  const [candidate, setCandidate] = useState<SearchResult | null>(null);
  const [typed, setTyped] = useState('');
  const [micError, setMicError] = useState<string | null>(null);
  const recRef = useRef<Recognizer | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const candidateRef = useRef<SearchResult | null>(null);
  candidateRef.current = candidate;
  const searchAbortRef = useRef<AbortController | null>(null);
  const { liveText } = useAnnouncer(nav, lang, false);
  const stt = sttSupported();
  const tts = ttsSupported();
  const session = nav.state.session;

  useEffect(() => {
    const id = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [headingRef]);

  /** Speak and show a prompt; `then` runs when speech ends (or at once without TTS). */
  const say = useCallback(
    (text: string, then?: () => void) => {
      setMessage(text);
      if (tts) speak(text, lang, { interrupt: true, onEnd: then });
      else then?.();
    },
    [lang, tts],
  );

  const listen = useCallback(() => {
    if (!recRef.current) return;
    setMicError(null);
    setInterim('');
    recRef.current.start();
  }, []);

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

  const goTo = useCallback(
    async (r: SearchResult) => {
      setPhase('routing');
      say(t('listen.say.routing', { name: localizedName(r, lang) }));
      const res = await onRoute({ lat: r.lat, lon: r.lon, label: localizedName(r, lang) });
      if (res !== 'ok') {
        setPhase('idle');
        say(t(`home.errors.${res}`) + ' ' + t('listen.say.tryDemo'), listen);
      }
    },
    [onRoute, say, t, lang, listen],
  );

  const handleText = useCallback(
    (raw: string) => {
      const text = raw.trim().toLowerCase();
      if (!text) return;
      const cmd = parseCommand(text);
      if (nav.state.session) {
        if (cmd === 'repeat') nav.repeat();
        else if (cmd === 'where') sayWhere();
        else if (cmd === 'stop') {
          onEnd();
          setPhase('idle');
          say(t('listen.say.stopped'));
        } else say(t('listen.say.unknownCommand'));
        return;
      }
      if (phaseRef.current === 'confirm' && candidateRef.current) {
        if (cmd === 'yes') void goTo(candidateRef.current);
        else if (cmd === 'no') {
          setCandidate(null);
          setPhase('idle');
          say(t('listen.say.whereTo'), listen);
        } else say(t('listen.say.sayYesOrNo'), listen);
        return;
      }
      if (cmd === 'demo') {
        setPhase('routing');
        say(t('listen.say.demoStarting'));
        onDemo();
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
            say(t('listen.say.found', { name: localizedName(top, lang) }), listen);
          } else {
            setPhase('idle');
            say(t('listen.say.notFound', { query: text }), listen);
          }
        })
        .catch(() => {
          if (ac.signal.aborted) return;
          setPhase('idle');
          say(t('listen.say.searchFailed'));
        });
    },
    [nav, sayWhere, onEnd, say, t, goTo, listen, onDemo, lang],
  );
  const handleTextRef = useRef(handleText);
  handleTextRef.current = handleText;

  // One recogniser for the screen's lifetime (rebuilt when the language changes).
  useEffect(() => {
    const rec = createRecognizer(lang, {
      onStart: () => {
        setPhase((p) => (p === 'idle' ? 'listening' : p));
      },
      onInterim: (text) => setInterim(text),
      onResult: (text) => {
        setInterim('');
        handleTextRef.current(text);
      },
      onError: (kind) => {
        if (kind === 'aborted') return;
        setMicError(kind);
        setPhase((p) => (p === 'listening' ? 'idle' : p));
      },
      onEnd: () => {
        setPhase((p) => (p === 'listening' ? 'idle' : p));
      },
    });
    recRef.current = rec;
    return () => {
      rec?.dispose();
      recRef.current = null;
      searchAbortRef.current?.abort();
      stopSpeaking();
    };
  }, [lang]);

  // Routing outcome: the engine took over, or the planner reported an error.
  useEffect(() => {
    if (session) setPhase('navigating');
    else setPhase((p) => (p === 'navigating' ? 'idle' : p));
  }, [session]);
  const plannerError = planner.state.error;
  useEffect(() => {
    if (plannerError && phaseRef.current === 'routing') {
      setPhase('idle');
      say(t(`route.errors.${plannerError}`), listen);
    }
  }, [plannerError, say, t, listen]);

  const toggleListening = () => {
    if (!stt) return;
    if (phase === 'listening') {
      recRef.current?.stop();
      setPhase('idle');
      return;
    }
    stopSpeaking();
    if (!session && phase === 'idle' && !message) setMessage(t('listen.say.whereTo'));
    listen();
  };

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const text = typed;
    setTyped('');
    handleText(text);
  };

  const bigLabel = !stt
    ? t('listen.noStt')
    : phase === 'listening'
      ? t('listen.listening')
      : phase === 'thinking' || phase === 'routing'
        ? t('listen.thinking')
        : session
          ? t('listen.tapCommand')
          : phase === 'confirm'
            ? t('listen.tapAnswer')
            : t('listen.tapToSpeak');

  const step = nav.state.currentStep;
  const d = formatDistance(nav.state.distanceToStep);

  return (
    <section className="listen" aria-labelledby="listen-title" onDoubleClick={() => (session ? nav.repeat() : undefined)}>
      <h2 id="listen-title" className="listen__title" ref={headingRef as RefObject<HTMLHeadingElement>} tabIndex={-1}>
        {t('mode.listen.title')}
      </h2>
      {(!stt || !tts) && (
        <p className="listen__nosupport" role="alert">
          {!stt && !tts ? t('listen.noSpeech') : !stt ? t('listen.noSttLong') : t('listen.noTtsLong')}
        </p>
      )}

      <button
        type="button"
        className={`listen__big${phase === 'listening' ? ' listen__big--on' : ''}`}
        aria-pressed={phase === 'listening'}
        onClick={toggleListening}
        disabled={!stt}
      >
        <svg viewBox="0 0 48 48" width="72" height="72" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <rect x="18" y="6" width="12" height="22" rx="6" />
          <path d="M10 22a14 14 0 0 0 28 0M24 36v6M16 42h16" />
        </svg>
        <span className="listen__bigText">{bigLabel}</span>
      </button>

      <div className="listen__panel" lang={lang}>
        <p className="listen__message" aria-live="assertive" aria-atomic="true">
          {session && liveText ? liveText : message}
        </p>
        {interim && <p className="listen__interim">{t('listen.heard', { text: interim })}</p>}
        {micError && (
          <p className="place__error" role="alert">
            {t(`listen.micError.${micError}`)}
          </p>
        )}
        {session && step && (
          <p className="listen__step">
            {d.value} {t(`units.${d.unit}`)} · {stepInstruction(step, lang)}
          </p>
        )}
      </div>

      {/* Keyboard / no-speech fallback: the same flow with typed input and buttons. */}
      {!session && phase !== 'confirm' && (
        <form className="listen__form" onSubmit={submitTyped}>
          <label className="field__label" htmlFor="listen-typed">
            {t('listen.typeDestination')}
          </label>
          <div className="place__row">
            <input id="listen-typed" className="place__input" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" enterKeyHint="go" />
            <button type="submit" className="btn btn--primary" disabled={!typed.trim() || phase === 'thinking' || phase === 'routing'}>
              {t('listen.find')}
            </button>
          </div>
          <button type="button" className="btn listen__demo" onClick={() => handleText('demo')}>
            {t('home.demo')}
          </button>
        </form>
      )}
      {!session && phase === 'confirm' && candidate && (
        <div className="listen__confirm" role="group" aria-label={t('listen.confirmLabel')}>
          <button type="button" className="btn btn--primary btn--big" onClick={() => handleText('yes')}>
            {t('listen.yes', { name: localizedName(candidate, lang) })}
          </button>
          <button type="button" className="btn btn--big" onClick={() => handleText('no')}>
            {t('listen.no')}
          </button>
        </div>
      )}
      {session && (
        <div className="listen__cmds" role="group" aria-label={t('listen.commandsLabel')}>
          <button type="button" className="btn" onClick={() => nav.repeat()}>
            {t('listen.cmd.repeat')}
          </button>
          <button type="button" className="btn" onClick={sayWhere}>
            {t('listen.cmd.where')}
          </button>
          <button type="button" className="btn" onClick={onReport}>
            {t('report.fab')}
          </button>
          {nav.state.needsSimulation && !nav.state.simulating && (
            <button type="button" className="btn btn--primary" onClick={nav.startSimulation}>
              {t('nav.simulate')}
            </button>
          )}
          {nav.state.simulating && (
            <button type="button" className="btn" onClick={nav.stopSimulation}>
              {t('nav.simStop')}
            </button>
          )}
          <button
            type="button"
            className="btn listen__stop"
            onClick={() => {
              onEnd();
              say(t('listen.say.stopped'));
            }}
          >
            {t('listen.cmd.stop')}
          </button>
        </div>
      )}
      <p className="listen__help">{t('listen.help')}</p>
    </section>
  );
}
