import {
  SPARK_HEIGHT,
  SPARK_MID,
  SPARK_REACH,
  SPARK_WIDTH,
  buildSparkline,
} from '../logic/sparkline';
import { buildMixBreakdown, stackSegments } from '../logic/mixRows';
import { buildPriceBars } from '../logic/priceBars';
import { priceScale } from '../logic/mapAttrs';
import { borderTouches, buildFlowRows, flowTotals } from '../logic/flowsPanel';
import { alpha, TOKENS } from '../logic/ramps';
import { anyOf, emptyMessage, emptyReason } from '../logic/emptyState';
import { drawOnDelayed, drawOnSweep } from '../logic/drawOn';
import { euro, gw, percent, seriesRange, signedGw } from '../logic/format';
import { GRID_FUEL_KEYS } from '@/types';
import type { GridDay, GridFuelKey, GridHourSeries } from '@/types';

function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="lg-section-head">
      <span className="lg-label">{title}</span>
      {note && <span className="lg-note">{note}</span>}
    </div>
  );
}

/**
 * Says which kind of nothing this is: a zone silent all day, one whose data
 * has not reached the hour on screen yet, or a hole between hours that report.
 *
 * Only for a section whose emptiness IS "the hour has no value". A section
 * with a stricter rule than that must answer for itself — see `MixSection`.
 */
function NoData({
  what,
  series,
  hour,
}: {
  what: string;
  series?: readonly (number | null)[];
  hour: number;
}) {
  // A caller reaching here with a presence track that DOES carry this hour is
  // asking a stricter question than presence answers, and only it knows the
  // real answer. Say the little that is certain rather than defaulting to
  // "nothing today" — the strongest claim available, and false every time the
  // mix section used to reach it.
  const reason = emptyReason(series, hour);
  return (
    <div className="lg-note">
      {reason ? emptyMessage(reason, what) : `No ${what} to show for this hour.`}
    </div>
  );
}

/* ------------------------------------------------------------- sparkline */

export function NetSparkline({
  series,
  hour,
  reduced,
}: {
  series: GridHourSeries;
  hour: number;
  reduced: boolean;
}) {
  const spark = buildSparkline(series.map((v) => (v === null ? null : v / 1000)), hour);

  return (
    <div className="lg-section">
      <SectionHeading title="Net position" note={`±${spark.scale.toFixed(1)} GW`} />
      {spark.empty ? (
        <NoData what="net position" series={series} hour={hour} />
      ) : (
        <>
          <svg
            width="100%"
            viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
            style={{ display: 'block', overflow: 'visible' }}
            role="img"
            aria-label="Net position across the day"
          >
            <line x1="0" y1={SPARK_MID - SPARK_REACH} x2={SPARK_WIDTH} y2={SPARK_MID - SPARK_REACH} stroke="#122230" strokeWidth="1" />
            <line x1="0" y1={SPARK_MID + SPARK_REACH} x2={SPARK_WIDTH} y2={SPARK_MID + SPARK_REACH} stroke="#122230" strokeWidth="1" />
            <line x1="0" y1={SPARK_MID} x2={SPARK_WIDTH} y2={SPARK_MID} stroke="#1C3040" strokeWidth="1" />
            {/*
              One path per run rather than one for the whole series: the reveal
              is a sweep across the day, and a dash-offset over the joined path
              would measure geometric length, which a gap has none of — so it
              would jump the hole instead of leaving it empty for its share of
              the time. `pathLength={1}` normalises the dash maths, the same
              trick AbleLineChart uses.
            */}
            {/*
              Nothing here hides the path by itself: `lg-fade-in` and `lg-draw`
              declare their own `from`, so with no animation the curve simply
              renders. `pathLength={1}` normalises the dash maths, and a dash
              array of 1 against that length is a single dash covering the whole
              path — invisible at offset 1, complete at offset 0.
            */}
            {spark.runs.map((r) => (
              <path
                key={`a${r.startHour}`}
                d={r.areaD}
                fill={TOKENS.teal}
                fillOpacity="0.13"
                style={{ animation: drawOnSweep({ ...r, keyframes: 'lg-fade-in', reduced }) }}
              />
            ))}
            {spark.runs.map((r) => (
              <path
                key={`l${r.startHour}`}
                d={r.d}
                fill="none"
                stroke={TOKENS.teal}
                strokeWidth="1.6"
                strokeLinejoin="round"
                pathLength={1}
                style={{ strokeDasharray: 1, animation: drawOnSweep({ ...r, keyframes: 'lg-draw', reduced }) }}
              />
            ))}
            {spark.cursor && (
              <>
                <line
                  x1={spark.cursor.x}
                  y1="4"
                  x2={spark.cursor.x}
                  y2={SPARK_HEIGHT - 4}
                  stroke={TOKENS.textLabel}
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                <circle cx={spark.cursor.x} cy={spark.cursor.y} r="3.2" fill={TOKENS.textPrimary} />
              </>
            )}
          </svg>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 6,
              font: "400 10px 'IBM Plex Mono', monospace",
              color: TOKENS.textLabel,
            }}
          >
            <span>00:00</span>
            <span>24:00</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- mix */

export function MixSection({
  mix,
  hour,
  reduced,
}: {
  mix: Record<GridFuelKey, GridHourSeries> | undefined;
  hour: number;
  reduced: boolean;
}) {
  const breakdown = buildMixBreakdown(mix, hour);
  const segments = stackSegments(mix, hour);

  return (
    <div className="lg-section">
      <SectionHeading
        title="Generation mix"
        note={breakdown.empty ? undefined : `${gw(breakdown.totalMw)} GW`}
      />
      {breakdown.empty ? (
        breakdown.reported ? (
          // The zone published for this hour and what it published sums to
          // nothing. That is a measured zero, not an absence, and the presence
          // track cannot tell them apart — 0 is a value like any other.
          <div className="lg-note">{emptyMessage({ kind: 'zero' }, 'generation')}</div>
        ) : (
          <NoData
            what="generation"
            series={mix ? anyOf(GRID_FUEL_KEYS.map((f) => mix[f] ?? [])) : undefined}
            hour={hour}
          />
        )
      ) : (
        <>
          <div className="lg-stack">
            {segments.map((s, i) => (
              <span
                key={i}
                style={{
                  width: `${(s.share * 100).toFixed(2)}%`,
                  background: s.color,
                  // Width stays the real value; the growth is a transform, so
                  // the bar never reflows its neighbours while it animates.
                  transformOrigin: 'left center',
                  animation: drawOnDelayed({ index: i, count: segments.length, keyframes: 'lg-grow-x', reduced }),
                }}
              />
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            {breakdown.rows.map((row, i) => (
              <div
                key={row.fuel}
                className="lg-mix-row"
                style={{ animation: drawOnDelayed({ index: i, count: breakdown.rows.length, keyframes: 'chartFade', reduced }) }}
              >
                <span className="lg-mix-chip" style={{ background: row.color }} />
                <span className="lg-mix-name">{row.label}</span>
                <span className="lg-mix-bar">
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${(row.share * 100).toFixed(1)}%`,
                      background: row.color,
                      transformOrigin: 'left center',
                      animation: drawOnDelayed({ index: i, count: breakdown.rows.length, keyframes: 'lg-grow-x', reduced }),
                    }}
                  />
                </span>
                <span className="lg-mix-value">{gw(row.mw)}</span>
                <span className="lg-mix-pct">{percent(row.share, 0)}</span>
              </div>
            ))}
          </div>
          <div className="lg-note" style={{ marginTop: 10 }}>
            Renewable share {percent(breakdown.renewableShare, 0)} · reported generation only
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- prices */

export function PriceBarsSection({
  day,
  series,
  hour,
  onHour,
  reduced,
}: {
  day: GridDay;
  series: GridHourSeries | undefined;
  hour: number;
  onHour: (hour: number) => void;
  reduced: boolean;
}) {
  // Scaled across zones, not against this zone alone, so a bar and the country
  // it belongs to are painted the same colour by the same rule.
  const scale = priceScale(day, hour);
  const bars = buildPriceBars(series, hour, { scaleMin: scale.lo, scaleMax: scale.hi });
  const range = series ? seriesRange(series) : null;

  return (
    <div className="lg-section">
      <SectionHeading
        title="Day-ahead price"
        note={range ? `${euro(range.min)} – ${euro(range.max)}` : undefined}
      />
      {!range ? (
        <NoData what="day-ahead price" series={series} hour={hour} />
      ) : (
        <>
          <div className="lg-price-bars">
            {bars.map((bar) => (
              <button
                key={bar.hour}
                type="button"
                className="lg-price-bar"
                data-current={bar.current}
                style={{
                  height: bar.height,
                  background: bar.color,
                  visibility: bar.value === null ? 'hidden' : 'visible',
                  // The row is bottom-aligned, so growing from the baseline is
                  // what reads as the price rising into place.
                  transformOrigin: 'bottom center',
                  animation: drawOnDelayed({ index: bar.hour, count: bars.length, keyframes: 'chartGrow', reduced }),
                }}
                onClick={() => onHour(bar.hour)}
                title={
                  bar.value === null
                    ? `${String(bar.hour).padStart(2, '0')}:00 — not published`
                    : `${String(bar.hour).padStart(2, '0')}:00 — ${euro(bar.value)}`
                }
                aria-label={`Show hour ${bar.hour}`}
              />
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 6,
              font: "400 10px 'IBM Plex Mono', monospace",
              color: TOKENS.textLabel,
            }}
          >
            <span>00:00</span>
            <span>24:00</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- flows */

export function FlowsSection({
  day,
  code,
  hour,
  onPick,
}: {
  day: GridDay;
  code: string;
  hour: number;
  onPick: (code: string) => void;
}) {
  const rows = buildFlowRows(day.flows, code, hour);
  // Presence across every border this zone is on, so an hour with no flow can
  // be told apart from a zone with no borders reporting at all today.
  const borderPresence = anyOf(
    Object.entries(day.flows)
      .filter(([key]) => borderTouches(key, code))
      .map(([, s]) => s),
  );

  return (
    <div className="lg-section">
      <SectionHeading title="Cross-border flows" note={rows.length ? 'top borders' : undefined} />
      {rows.length === 0 ? (
        <NoData what="border flow" series={borderPresence} hour={hour} />
      ) : (
        <div>
          {rows.map((row) => {
            const colour = row.exporting ? TOKENS.teal : TOKENS.orange;
            return (
              <button
                key={row.other}
                type="button"
                className="lg-flow-row"
                onClick={() => onPick(row.other)}
                title={`Select ${row.label}`}
              >
                <span className="lg-flow-glyph" style={{ color: colour }}>
                  {row.exporting ? '→' : '←'}
                </span>
                <span className="lg-flow-name">
                  {row.label} <span style={{ color: TOKENS.textLabel }}>({row.other})</span>
                </span>
                <span className="lg-flow-value" style={{ color: colour }}>
                  {signedGw(row.mw)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- key figures */

export function KeyFigures({
  day,
  code,
  hour,
  netSeries,
  reduced,
}: {
  day: GridDay;
  code: string;
  hour: number;
  netSeries: GridHourSeries;
  reduced: boolean;
}) {
  const zone = day.zones[code];
  const mix = buildMixBreakdown(zone?.mix, hour);
  const totals = flowTotals(day.flows, code, hour);
  const priceRange = zone ? seriesRange(zone.price) : null;

  const rows: { label: string; value: string; color?: string }[] = [
    // Keyed on `reported`, not `empty`: a zone that published zeros reads
    // "0.0 GW" here, matching what the mix section says two rows up. Only a
    // zone that published nothing gets the em dash.
    { label: 'Generation', value: mix.reported ? `${gw(mix.totalMw)} GW` : '—' },
    { label: 'Load', value: zone?.load[hour] == null ? '—' : `${gw(zone.load[hour])} GW` },
    {
      label: 'Net position',
      value: netSeries[hour] == null ? '—' : `${signedGw(netSeries[hour])} GW`,
      color: (netSeries[hour] ?? 0) >= 0 ? TOKENS.teal : TOKENS.orange,
    },
    { label: 'Day-ahead price', value: euro(zone?.price[hour] ?? null) },
    {
      label: 'Day range',
      value: priceRange ? `${euro(priceRange.min)} – ${euro(priceRange.max)}` : '—',
    },
    { label: 'Renewable share', value: percent(mix.renewableShare, 0) },
    {
      label: 'Exchange',
      value: totals ? `${gw(totals.exported)} out · ${gw(totals.imported)} in` : '—',
    },
  ];

  return (
    <div className="lg-section">
      <SectionHeading title="Key figures" />
      <div>
        {rows.map((row, i) => (
          <div
            key={row.label}
            style={{
              animation: drawOnDelayed({ index: i, count: rows.length, keyframes: 'chartFade', reduced }),
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              padding: '7px 0',
              borderTop: `1px solid ${alpha('#122230', 1)}`,
            }}
          >
            <span style={{ font: "400 12.5px 'IBM Plex Sans'", color: TOKENS.textMuted }}>
              {row.label}
            </span>
            <span style={{ font: "400 12.5px 'IBM Plex Mono', monospace", color: row.color ?? TOKENS.textPrimary }}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
