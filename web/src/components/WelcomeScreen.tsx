// First-run onboarding ("login" without a password): language, how you move,
// your name. The choice sets the travel profile and the guidance mode:
// wheelchair / walking aid / pram -> Move, dyslexic or autistic -> Explore,
// blind or low vision -> Listen. A blind traveller never needs the screen: the
// greeting is spoken, a double tap anywhere (or "I can't see") picks Listen.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Profile } from '../api';
import { LANGS, type Lang } from '../i18n';
import { Icon, PROFILE_ICONS } from '../icons';
import { PROFILE_MODE } from '../mode';
import { createRecognizer, isNativeApp, parseCommand, speak, stopSpeaking, ttsSupported, type Recognizer } from '../speech';

export interface OnboardingChoice {
  profile: Profile;
  name: string;
  /** True when chosen through the spoken path (double tap / "I can't see"). */
  voice: boolean;
}

interface WelcomeScreenProps {
  lang: Lang;
  onLang: (lang: Lang) => void;
  onDone: (choice: OnboardingChoice) => Promise<void>;
  initialProfile?: Profile | null;
  initialName?: string;
}

/** Display order: the three mobility profiles, then the two sensory / cognitive ones, then walking. */
const ORDER: readonly Profile[] = ['wheelchair_manual', 'elderly_walking_aid', 'pram', 'cognitive', 'blind_low_vision', 'walker'] as const;
const DOUBLE_TAP_MS = 450;
const MAX_VOICE_ROUNDS = 3;

export default function WelcomeScreen({ lang, onLang, onDone, initialProfile = null, initialName = '' }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const id = useId();
  const [profile, setProfile] = useState<Profile | null>(initialProfile);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heard, setHeard] = useState('');
  const lastTapRef = useRef(0);
  const doneRef = useRef(false);
  const recRef = useRef<Recognizer | null>(null);
  const roundsRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const finish = useCallback(
    async (choice: OnboardingChoice) => {
      if (doneRef.current) return;
      doneRef.current = true;
      recRef.current?.dispose();
      recRef.current = null;
      setBusy(true);
      setError(null);
      try {
        await onDone(choice);
      } catch (err) {
        console.warn('[welcome]', err);
        doneRef.current = false;
        setBusy(false);
        setError(t('welcome.error'));
      }
    },
    [onDone, t],
  );

  const chooseBlind = useCallback(() => {
    stopSpeaking();
    setProfile('blind_low_vision');
    if (ttsSupported()) speak(t('welcome.say.blindChosen'), lang, { interrupt: true });
    void finish({ profile: 'blind_low_vision', name: name.trim() || t('welcome.defaultName'), voice: true });
  }, [finish, lang, name, t]);
  const chooseBlindRef = useRef(chooseBlind);
  chooseBlindRef.current = chooseBlind;

  // Spoken greeting on arrival; in the native app also listen for "I can't see" a few times.
  useEffect(() => {
    const h = window.setTimeout(() => headingRef.current?.focus(), 0);
    if (ttsSupported()) speak(t('welcome.say.greeting'), lang, { interrupt: true, onEnd: () => startVoice() });
    else startVoice();
    function startVoice() {
      if (!isNativeApp() || doneRef.current) return;
      if (recRef.current) return;
      const rec = createRecognizer(lang, {
        onInterim: (text) => setHeard(text),
        onResult: (text) => {
          setHeard(text);
          if (parseCommand(text) === 'cantSee') chooseBlindRef.current();
        },
        onEnd: () => {
          roundsRef.current += 1;
          if (!doneRef.current && roundsRef.current < MAX_VOICE_ROUNDS) window.setTimeout(() => recRef.current?.start(), 400);
        },
        onError: () => undefined,
      });
      recRef.current = rec;
      rec?.start();
    }
    return () => {
      window.clearTimeout(h);
      recRef.current?.dispose();
      recRef.current = null;
      stopSpeaking();
    };
    // Greeting once per mount, in the language of arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Double tap on any non-interactive part of the screen = "I can't see".
  const onBackgroundClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, label, a, select, textarea')) return;
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      chooseBlind();
    } else {
      lastTapRef.current = now;
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!profile) {
      setError(t('welcome.pickOne'));
      return;
    }
    if (profile === 'blind_low_vision') {
      chooseBlind();
      return;
    }
    void finish({ profile, name: name.trim() || t('welcome.defaultName'), voice: false });
  };

  return (
    <div className="welcome" onClick={onBackgroundClick} role="presentation">
      <header className="welcome__hero">
        <div className="welcome__brandrow">
          <p className="welcome__brand">
            {t('app.name')}
            <span className="welcome__tagline">{t('welcome.tagline')}</span>
          </p>
          <div className="segmented segmented--onhero" role="group" aria-label={t('lang.label')}>
            {LANGS.map((code) => (
              <button key={code} type="button" className="btn segmented__btn" lang={code} aria-pressed={lang === code} onClick={() => onLang(code)}>
                {t(`lang.${code}`)}
              </button>
            ))}
          </div>
        </div>
        <h1 className="welcome__title" ref={headingRef} tabIndex={-1}>
          {t('welcome.title')}
        </h1>
        <p className="welcome__sub">{t('welcome.sub')}</p>
      </header>

      <form className="welcome__form" onSubmit={submit}>
        <fieldset className="welcome__grid">
          <legend className="sr-only">{t('welcome.title')}</legend>
          {ORDER.map((p) => {
            const mode = PROFILE_MODE[p];
            return (
              <label key={p} className={`profilecard profilecard--${mode}`}>
                <input type="radio" name={`${id}-profile`} value={p} checked={profile === p} onChange={() => setProfile(p)} />
                <span className="profilecard__icon">
                  <Icon name={PROFILE_ICONS[p]} size={30} />
                </span>
                <span className="profilecard__title">{t(`welcome.profiles.${p}.title`)}</span>
                <span className="profilecard__line">{t(`welcome.profiles.${p}.line`)}</span>
                <span className="profilecard__mode">{t('welcome.opens', { mode: t(`mode.${mode}.title`) })}</span>
              </label>
            );
          })}
        </fieldset>

        <label className="field welcome__name">
          <span className="field__label">{t('welcome.name')}</span>
          <input type="text" value={name} maxLength={40} autoComplete="nickname" placeholder={t('welcome.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </label>

        {error && (
          <p className="place__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn--primary btn--big welcome__continue" disabled={busy} aria-busy={busy}>
          {busy ? t('welcome.saving') : t('welcome.continue')}
        </button>
      </form>

      <div className="welcome__blind">
        <button type="button" className="btn btn--dark btn--big welcome__cantsee" onClick={chooseBlind} disabled={busy}>
          <Icon name="eye-off" size={26} />
          {t('welcome.cantSee')}
        </button>
        <p className="welcome__hint">{t('welcome.cantSeeHint')}</p>
        {heard && <p className="welcome__heard">{t('listen.heard', { text: heard })}</p>}
      </div>
    </div>
  );
}
