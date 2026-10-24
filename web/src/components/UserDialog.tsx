import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PROFILES, type Profile } from '../api';
import type { Lang } from '../i18n';
import { PROFILE_KEY } from '../routePlanner';
import { createUser, trustLevel, useUser } from '../user';

export const PROFILE_GLYPHS: Record<Profile, string> = {
  walker: '🚶',
  wheelchair_manual: '♿',
  elderly_walking_aid: '🧓',
  pram: '🍼',
  cognitive: '🧩',
  blind_low_vision: '🦯',
};

function storedProfile(): Profile {
  try {
    const v = localStorage.getItem(PROFILE_KEY);
    if (v && (PROFILES as readonly string[]).includes(v)) return v as Profile;
  } catch {
    /* ignore */
  }
  return 'walker';
}

/** Keep Tab inside a modal: wrap from the last focusable element to the first and back. */
export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  const root = e.currentTarget;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

interface UserDialogProps {
  lang: Lang;
  /** Called once the user exists (created or kept). */
  onDone: () => void;
  /** Cancel is offered only when the caller can live without a user (e.g. closing the sheet). */
  onCancel?: () => void;
}

/** "Who are you?" - display name + profile; POST /users; stored in localStorage `samaan.user`. */
export default function UserDialog({ lang, onDone, onCancel }: UserDialogProps) {
  const { t } = useTranslation();
  const id = useId();
  const existing = useUser();
  const [name, setName] = useState(existing?.display_name ?? '');
  const [profile, setProfile] = useState<Profile>(existing?.profile ?? storedProfile());
  const [team, setTeam] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'nameRequired' | 'generic' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(h);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('nameRequired');
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createUser(trimmed, profile, lang, team);
      onDone();
    } catch (err) {
      console.warn('[user]', err);
      setError('generic');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    trapTab(e);
  };

  return (
    <div className="modal" role="presentation">
      <form
        className="modal__card userdlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-intro`}
        onSubmit={(e) => void submit(e)}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`} className="panel__title">
          {t('user.title')}
        </h2>
        <p id={`${id}-intro`} className="panel__hint">
          {t('user.intro')}
        </p>
        <label className="field">
          <span className="field__label">{t('user.name')}</span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            maxLength={40}
            autoComplete="nickname"
            placeholder={t('user.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={error === 'nameRequired' || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
          />
        </label>
        <fieldset className="choices">
          <legend className="field__label">{t('user.profile')}</legend>
          {PROFILES.map((p) => (
            <label key={p} className="choice">
              <input type="radio" name={`${id}-profile`} value={p} checked={profile === p} onChange={() => setProfile(p)} />
              <span className="choice__glyph" aria-hidden="true">
                {PROFILE_GLYPHS[p]}
              </span>
              <span className="choice__text">{t(`route.profile.${p}`)}</span>
            </label>
          ))}
        </fieldset>
        <label className="choice">
          <input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} />
          <span className="choice__text">
            {t('user.team')}
            <span className="hint"> {t('user.teamHint')}</span>
          </span>
        </label>
        {error && (
          <p id={`${id}-error`} className="place__error" role="alert">
            {t(error === 'nameRequired' ? 'user.nameRequired' : 'user.error')}
          </p>
        )}
        <div className="planner__actions">
          <button type="submit" className="btn btn--primary" aria-busy={saving} disabled={saving}>
            {saving ? t('user.saving') : t('user.create')}
          </button>
          {onCancel && (
            <button type="button" className="btn" onClick={onCancel}>
              {t('user.cancel')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** "You: Riya · Trust 0.3 · new" with a Change button. */
export function UserChip({ onChange }: { onChange: () => void }) {
  const { t } = useTranslation();
  const user = useUser();
  if (!user) return null;
  const score = Math.round(user.trust_score * 100) / 100;
  return (
    <p className="userchip">
      <span className="userchip__name">
        <span aria-hidden="true">{PROFILE_GLYPHS[user.profile] ?? '🚶'} </span>
        {t('user.chip', { name: user.display_name })}
      </span>
      <span className="userchip__trust">{t('user.trust', { score: score.toFixed(2), level: t(`user.level.${trustLevel(user.trust_score)}`) })}</span>
      <button type="button" className="btn btn--small" onClick={onChange}>
        {t('user.change')}
      </button>
    </p>
  );
}
