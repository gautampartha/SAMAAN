// One small stroke-icon set (24 x 24, currentColor) so the UI does not rely on
// emoji, which render differently on every phone. Every icon is decorative:
// aria-hidden, the text next to it carries the meaning.
import type { SVGProps } from 'react';
import type { Profile } from './api';

export type IconName =
  | 'wheelchair'
  | 'cane'
  | 'puzzle'
  | 'pram'
  | 'elderly'
  | 'walk'
  | 'mic'
  | 'camera'
  | 'map'
  | 'flag'
  | 'gift'
  | 'coin'
  | 'chevron'
  | 'locate'
  | 'settings'
  | 'chart'
  | 'check'
  | 'star'
  | 'route'
  | 'ride'
  | 'target'
  | 'play'
  | 'refresh'
  | 'eye-off'
  | 'globe'
  | 'sparkle'
  | 'warning';

const PATHS: Record<IconName, JSX.Element> = {
  wheelchair: (
    <>
      <circle cx="9" cy="16.5" r="4.5" />
      <circle cx="18.5" cy="18.5" r="1.8" />
      <path d="M9 12V6.5h5l2.5 5h3.2" />
      <circle cx="9.5" cy="3.2" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  cane: (
    <>
      <circle cx="12" cy="3.5" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 6.5v6l-3 8M12 12.5l3 8M8 9l4-2 4 2" />
      <path d="M16.5 10.5 20.5 21" />
    </>
  ),
  puzzle: (
    <path d="M9 3.5h4a1.5 1.5 0 0 1 0 3v1.5H16a1.5 1.5 0 0 1 1.5 1.5v2.5a1.75 1.75 0 1 1 0 3.5V18a1.5 1.5 0 0 1-1.5 1.5h-2.5a1.75 1.75 0 1 0-3.5 0H7A1.5 1.5 0 0 1 5.5 18v-3a1.75 1.75 0 1 1 0-3.5v-2A1.5 1.5 0 0 1 7 8h2V6.5a1.5 1.5 0 0 1 0-3z" />
  ),
  pram: (
    <>
      <path d="M4 5h2l1.5 9h10.5l1.5-6H8" />
      <circle cx="9" cy="18.5" r="2" />
      <circle cx="16.5" cy="18.5" r="2" />
    </>
  ),
  elderly: (
    <>
      <circle cx="11" cy="4" r="1.7" fill="currentColor" stroke="none" />
      <path d="M11 7v6l-2.5 7M11 13l2.5 7M11 8l3.5 3" />
      <path d="M17 11v10" />
    </>
  ),
  walk: (
    <>
      <circle cx="13" cy="3.8" r="1.7" fill="currentColor" stroke="none" />
      <path d="M12.5 7 9 12l2 2.5-1.5 6M12.5 7l3 3 2.5 1M11 14.5l-3.5 3" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  map: (
    <>
      <path d="M3 6.5 9 4l6 2.5 6-2.5v13.5L15 20l-6-2.5-6 2.5z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </>
  ),
  flag: <path d="M6 21V4m0 0h11l-2.5 4L17 12H6" />,
  gift: (
    <>
      <path d="M4 10h16v10H4zM3 7h18v3H3zM12 7v13" />
      <path d="M12 7c-1.5-3-5-3.5-5-1s3.5 1 5 1zm0 0c1.5-3 5-3.5 5-1s-3.5 1-5 1z" />
    </>
  ),
  coin: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9.5h4a1.75 1.75 0 0 1 0 3.5H10h3.5a1.75 1.75 0 0 1 0 3.5h-4M12 7.5v1.5M12 15v1.5" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  locate: (
    <>
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 2.5V6M12 18v3.5M2.5 12H6M18 12h3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8 14 5l3-.6 1.2 2.8 2.8 1.2-.6 3 2.2 2-2.2 2 .6 3-2.8 1.2L17 21.6l-3-.6-2 2.2-2-2.2-3 .6-1.2-2.8L3 17.6l.6-3-2.2-2 2.2-2-.6-3L5.8 6.4 7 3.6l3 .6z" />
    </>
  ),
  chart: <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  star: <path d="m12 3 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.4l-5.7 3.1 1.2-6.4L2.8 9.7l6.4-.8z" />,
  route: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.5" />
    </>
  ),
  ride: (
    <>
      <circle cx="7" cy="17" r="3.5" />
      <circle cx="17" cy="17" r="3.5" />
      <path d="M7 17 10 9h4l3 8M10 9l-1.5-4H6" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  play: <path d="M7 4.5v15l12-7.5z" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" />,
  'eye-off': (
    <>
      <path d="M3 3l18 18M10.5 5.3A10.6 10.6 0 0 1 12 5.2c5 0 8.6 3.6 10 6.8a12 12 0 0 1-3.4 4.4M6.3 6.6A12.3 12.3 0 0 0 2 12c1.4 3.2 5 6.8 10 6.8 1.6 0 3-.3 4.3-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17" />
    </>
  ),
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  warning: (
    <>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 9.5v5M12 17.3v.2" />
    </>
  ),
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 24, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

export const PROFILE_ICONS: Record<Profile, IconName> = {
  walker: 'walk',
  wheelchair_manual: 'wheelchair',
  elderly_walking_aid: 'elderly',
  pram: 'pram',
  cognitive: 'puzzle',
  blind_low_vision: 'cane',
};
