import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { LAYER_KEYS, type LayerKey } from '../api';
import { IMAGE_COLOURS } from './MapView';
import { BarrierRingSwatch, ROUTE_ENDPOINT_COLOURS, RouteSwatch, UnknownOverlaySwatch } from './routeStyles';

interface LegendProps {
  visible: Record<LayerKey, boolean>;
  onToggle: (key: LayerKey) => void;
  onClose: () => void;
  /** Focused when the panel opens; the close button returns focus to the opener. */
  headingRef?: RefObject<HTMLHeadingElement>;
}

/** Small inline SVG swatches. Each legend row also carries a text description
 *  of the pattern so meaning never depends on colour alone. */
function LineSwatch({ colour, width, dash, casing }: { colour: string; width: number; dash?: string; casing?: boolean }) {
  return (
    <svg className="swatch" viewBox="0 0 56 16" width="56" height="16" aria-hidden="true" focusable="false">
      {casing && <line x1="4" y1="8" x2="52" y2="8" stroke="#ffffff" strokeWidth={width + 5} strokeLinecap="round" />}
      <line x1="4" y1="8" x2="52" y2="8" stroke={colour} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
}

function BarrierSwatch() {
  return (
    <svg className="swatch" viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <circle cx="10" cy="12" r="5" fill="#f9a825" stroke="#fff" strokeWidth="1.5" />
      <circle cx="28" cy="12" r="8" fill="#ef6c00" stroke="#fff" strokeWidth="1.5" />
      <circle cx="46" cy="12" r="10" fill="#b71c1c" stroke="#fff" strokeWidth="1.5" />
      <text x="46" y="16" textAnchor="middle" fontSize="10" fill="#fff" fontWeight="700">5</text>
    </svg>
  );
}

function AnchorSwatch() {
  return (
    <svg className="swatch" viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <circle cx="28" cy="12" r="7" fill="#ffffff" stroke="#263238" strokeWidth="3" />
    </svg>
  );
}

/** Image position: coloured circle plus the heading arrow (shown when a heading is known). */
function ImageSwatch({ colour, ring, radius }: { colour: string; ring: string; radius: number }) {
  return (
    <svg className="swatch" viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <circle cx="22" cy="12" r={radius} fill={colour} stroke={ring} strokeWidth="2" />
      <path d="M40 3 L46 19 L40 15 L34 19 Z" fill="#111111" stroke="#ffffff" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function EndpointSwatch({ colour, label }: { colour: string; label: string }) {
  return (
    <svg className="swatch" viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <circle cx="28" cy="12" r="10" fill={colour} stroke="#fff" strokeWidth="2.5" />
      <text x="28" y="16" textAnchor="middle" fontSize="11" fill="#fff" fontWeight="700">{label}</text>
    </svg>
  );
}

export default function Legend({ visible, onToggle, onClose, headingRef }: LegendProps) {
  const { t } = useTranslation();

  return (
    <div className="panel__inner">
      <div className="panel__head">
        <h2 id="legend-title" className="panel__title" ref={headingRef} tabIndex={-1}>{t('panels.legend')}</h2>
        <button type="button" className="btn btn--icon" onClick={onClose} aria-label={t('panels.close')}>
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <fieldset className="layer-toggles">
        <legend className="panel__subtitle">{t('layers.title')}</legend>
        {LAYER_KEYS.map((key) => (
          <label key={key} className="toggle">
            <input type="checkbox" checked={visible[key]} onChange={() => onToggle(key)} />
            <span>{t(`layers.${key}`)}</span>
          </label>
        ))}
      </fieldset>

      <h3 className="panel__subtitle">{t('legend.routeTitle')}</h3>
      <dl className="legend">
        <div className="legend__row">
          <dt><RouteSwatch mode="shortest" /> {t('route.mode.shortest.title')}</dt>
          <dd>{t('legend.routeShortest')}</dd>
        </div>
        <div className="legend__row">
          <dt><RouteSwatch mode="naive_accessible" /> {t('route.mode.naive_accessible.title')}</dt>
          <dd>{t('legend.routeNaive')}</dd>
        </div>
        <div className="legend__row">
          <dt><RouteSwatch mode="samaan" /> {t('route.mode.samaan.title')}</dt>
          <dd>{t('legend.routeSamaan')}</dd>
        </div>
        <div className="legend__row">
          <dt><UnknownOverlaySwatch /> {t('state.unknown')}</dt>
          <dd>{t('legend.routeUnknown')}</dd>
        </div>
        <div className="legend__row">
          <dt><BarrierRingSwatch /> {t('layers.barriers')}</dt>
          <dd>{t('legend.routeBarrier')}</dd>
        </div>
        <div className="legend__row">
          <dt><EndpointSwatch colour={ROUTE_ENDPOINT_COLOURS.origin} label="A" /> {t('route.origin')}</dt>
          <dd>{t('legend.demoOrigin')}</dd>
        </div>
        <div className="legend__row">
          <dt><EndpointSwatch colour={ROUTE_ENDPOINT_COLOURS.destination} label="B" /> {t('route.destination')}</dt>
          <dd>{t('legend.demoDestination')}</dd>
        </div>
      </dl>

      <h3 className="panel__subtitle">{t('legend.title')}</h3>
      <dl className="legend">
        <div className="legend__row">
          <dt><LineSwatch colour="#1b7f3b" width={4} /> {t('state.clear')}</dt>
          <dd>{t('legend.clear')}</dd>
        </div>
        <div className="legend__row">
          <dt><LineSwatch colour="#c62828" width={6} dash="0.5 9" /> {t('state.blocked')}</dt>
          <dd>{t('legend.blocked')}</dd>
        </div>
        <div className="legend__row">
          <dt><LineSwatch colour="#6d6d6d" width={3} dash="9 6" /> {t('state.unknown')}</dt>
          <dd>{t('legend.unknown')}</dd>
        </div>
        <div className="legend__row">
          <dt><BarrierSwatch /> {t('layers.barriers')}</dt>
          <dd>{t('legend.barrier')}</dd>
        </div>
        <div className="legend__row">
          <dt><AnchorSwatch /> {t('layers.anchors')}</dt>
          <dd>{t('legend.anchor')}</dd>
        </div>
        <div className="legend__row">
          <dt><LineSwatch colour="#5e35b1" width={6} dash="12 6" casing /> {t('layers.demo')}</dt>
          <dd>{t('legend.demoPath')}</dd>
        </div>
        <div className="legend__row">
          <dt><EndpointSwatch colour="#1b5e20" label="A" /> {t('demo.origin')}</dt>
          <dd>{t('legend.demoOrigin')}</dd>
        </div>
        <div className="legend__row">
          <dt><EndpointSwatch colour="#5e35b1" label="B" /> {t('demo.destination')}</dt>
          <dd>{t('legend.demoDestination')}</dd>
        </div>
        <div className="legend__row">
          <dt><LineSwatch colour="rgba(21,101,192,0.4)" width={10} /> {t('layers.coverage')}</dt>
          <dd>
            {t('legend.coverageObserved')}; {t('legend.coverageUnobserved')}. {t('legend.coverageDetail')}
          </dd>
        </div>
        <div className="legend__row">
          <dt><ImageSwatch colour={IMAGE_COLOURS.own} ring="#111111" radius={6} /> {t('images.source.own')}</dt>
          <dd>{t('legend.imageOwn')}</dd>
        </div>
        <div className="legend__row">
          <dt><ImageSwatch colour={IMAGE_COLOURS.mapillary} ring="#ffffff" radius={5} /> {t('images.source.mapillary')}</dt>
          <dd>{t('legend.imageMapillary')}</dd>
        </div>
        <div className="legend__row">
          <dt><ImageSwatch colour={IMAGE_COLOURS.report} ring="#ffffff" radius={5} /> {t('images.source.report')}</dt>
          <dd>{t('legend.imageReport')}</dd>
        </div>
        <div className="legend__row">
          <dt>{t('legend.imageArrowTitle')}</dt>
          <dd>{t('legend.imageArrow')}</dd>
        </div>
      </dl>
    </div>
  );
}
