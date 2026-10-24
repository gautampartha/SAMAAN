// Turns navigation announcements (start / step / arrive) into spoken text and a
// live-region string. One hook per mounted screen; a module-level "last spoken
// id" makes sure switching between Navigate / Explore / Listen does not repeat
// the current step.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RouteMode, RouteStep } from '../api';
import type { Lang } from '../i18n';
import type { Announcement, NavigationApi } from '../navigation';
import { speak, ttsSupported } from '../speech';

let lastSpokenId = 0;

export function stepInstruction(step: RouteStep | null, lang: Lang): string {
  if (!step) return '';
  return (lang === 'hi' ? step.instruction_hi || step.instruction_en : step.instruction_en || step.instruction_hi) ?? '';
}

export function stepStreet(step: RouteStep | null, lang: Lang): string | null {
  if (!step) return null;
  return lang === 'hi' ? step.street_hi || step.street_en : step.street_en || step.street_hi;
}

export function warningName(w: { name_en: string; name_hi: string }, lang: Lang): string {
  return lang === 'hi' ? w.name_hi || w.name_en : w.name_en || w.name_hi;
}

export function useAnnouncer(nav: NavigationApi, lang: Lang, muted: boolean): { liveText: string; compose: (a: Announcement) => string } {
  const { t } = useTranslation();
  const [liveText, setLiveText] = useState('');
  const { announcement, session } = nav.state;

  const compose = (a: Announcement): string => {
    const parts: string[] = [];
    if (a.kind === 'start' && session) {
      const c = session.route.confidence;
      parts.push(
        t('nav.say.start', {
          route: t(`route.mode.${session.mode as RouteMode}.title`),
          label: t(`confidence.${c?.label ?? 'low'}`),
          pct: Math.round(session.route.verified_pct),
        }),
      );
      const depart = stepInstruction(a.step, lang);
      if (depart) parts.push(depart);
    } else if (a.kind === 'step') {
      const instr = stepInstruction(a.step, lang);
      parts.push(a.distance >= 15 ? t('nav.say.stepIn', { distance: Math.round(a.distance / 5) * 5, instruction: instr }) : instr);
      for (const w of a.step?.warnings ?? []) {
        parts.push(t(w.impassable_for_profile ? 'nav.say.warningImpassable' : 'nav.say.warning', { name: warningName(w, lang) }));
      }
    } else if (a.kind === 'arrive') {
      parts.push(t('nav.say.arrive'));
    }
    return parts.join(' ');
  };

  useEffect(() => {
    if (!announcement) return;
    const text = compose(announcement);
    setLiveText(text);
    if (announcement.id === lastSpokenId) return;
    lastSpokenId = announcement.id;
    if (!muted && ttsSupported()) speak(text, lang, { interrupt: true });
    // `compose` reads t/lang/session, all stable for a given announcement id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcement?.id]);

  return { liveText, compose };
}
