import {
  SPARK_HEIGHT,
  SPARK_MID,
  SPARK_REACH,
  SPARK_WIDTH,
  buildSparkline,
} from '../logic/sparkline';
import { buildMixBreakdown, stackSegments } from '../logic/mixRows';
import { buildPriceBars } from '../logic/priceBars';
import { buildFlowRows, flowTotals } from '../logic/flowsPanel';
import { alpha, TOKENS } from '../logic/ramps';
import { euro, gw, percent, seriesRange, signedGw } from '../logic/format';
import type { GridDay, GridFuelKey, GridHourSeries } from '@/types';

function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="lg-section-head">
      <span className="lg-label">{title}</span>
      {note && <span className="lg-note">{note}</span>}
    </div>
  );
}

function NoData({ what }: { what: string }) {
  return <div className="lg-note">No {what} published for this zone today.</div>;
}

/* ------------------------------------------------------------- sparkline */

export function NetSparkline({
  series,
  hour,
}: {
  series: GridHourSeries;
  hour: number;
}) {
  const spark = buildSparkline(series.map((v) => (v === null ? null : v / 1000)), hour);

  return (
    <div className="lg-section">
      <SectionHeading title="Net position" note={`±${spark.scale.toFixed(1)} GW`} />
      {spark.empty ? (
        <NoData what="net position" />
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
            <path d={spark.area} fill={TOKENS.teal} fillOpacity="0.13" />
            <path d={spark.line} fill="none" stroke={TOKENS.teal} strokeWidth="1.6" strokeLinejoin="round" />
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
}: {
  mix: Record<GridFuelKey, GridHourSeries> | undefined;
  hour: number;
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
        <NoData what="generation" />
      ) : (
        <>
          <div className="lg-stack">
            {segments.map((s, i) => (
              <span key={i} style={{ width: `${(s.share * 100).toFixed(2)}%`, background: s.color }} />
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            {breakdown.rows.map((row) => (
              <div key={row.fuel} className="lg-mix-row">
                <span className="lg-mix-chip" style={{ background: row.color }} />
                <span className="lg-mix-name">{row.label}</span>
                <span className="lg-mix-bar">
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${(row.share * 100).toFixed(1)}%`,
                      background: row.color,
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
  series,
  hour,
  onHour,
}: {
  series: GridHourSeries | undefined;
  hour: number;
  onHour: (hour: number) => void;
}) {
  const bars = buildPriceBars(series, hour);
  const range = series ? seriesRange(series) : null;

  return (
    <div className="lg-section">
      <SectionHeading
        title="Day-ahead price"
        note={range ? `${euro(range.min)} – ${euro(range.max)}` : undefined}
      />
      {!range ? (
        <NoData what="day-ahead price" />
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

  return (
    <div className="lg-section">
      <SectionHeading title="Cross-border flows" note={rows.length ? 'top borders' : undefined} />
      {rows.length === 0 ? (
        <NoData what="border flow" />
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
}: {
  day: GridDay;
  code: string;
  hour: number;
  netSeries: GridHourSeries;
}) {
  const zone = day.zones[code];
  const mix = buildMixBreakdown(zone?.mix, hour);
  const totals = flowTotals(day.flows, code, hour);
  const priceRange = zone ? seriesRange(zone.price) : null;

  const rows: { label: string; value: string; color?: string }[] = [
    { label: 'Generation', value: mix.empty ? '—' : `${gw(mix.totalMw)} GW` },
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
        {rows.map((row) => (
          <div
            key={row.label}
            style={{
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
