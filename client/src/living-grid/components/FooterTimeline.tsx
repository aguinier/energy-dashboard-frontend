import { useRef } from 'react';
import { STEPS } from '../logic/livingGridState';
import { hourAtPosition, isLive, progressPercent, ticks } from '../logic/timeline';
import { dayLabel } from '../logic/format';

interface FooterTimelineProps {
  hour: number;
  playing: boolean;
  step: number;
  date: string;
  currentHour: number;
  isToday: boolean;
  onHour: (hour: number) => void;
  onTogglePlay: () => void;
  onCycleStep: () => void;
  onLive: () => void;
}

export function FooterTimeline({
  hour,
  playing,
  step,
  date,
  currentHour,
  isToday,
  onHour,
  onTogglePlay,
  onCycleStep,
  onLive,
}: FooterTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const live = isLive(hour, currentHour, isToday);

  const seek = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    onHour(hourAtPosition(clientX - rect.left, rect.width));
  };

  return (
    <footer className="lg-footer">
      <button
        type="button"
        className="lg-play"
        onClick={onTogglePlay}
        aria-label={playing ? 'Pause the timeline' : 'Play the timeline'}
      >
        {playing ? (
          <svg width="13" height="14" viewBox="0 0 13 14" fill="currentColor" aria-hidden>
            <rect x="0" y="0" width="4.5" height="14" rx="1" />
            <rect x="8.5" y="0" width="4.5" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="13" height="14" viewBox="0 0 13 14" fill="currentColor" aria-hidden>
            <path d="M1 1.2c0-.9 1-1.4 1.7-.9l9 5.8c.7.4.7 1.4 0 1.8l-9 5.8c-.7.5-1.7 0-1.7-.9V1.2z" />
          </svg>
        )}
      </button>

      <div style={{ font: "400 11.5px 'IBM Plex Mono', monospace", color: 'var(--lg-clock)', whiteSpace: 'nowrap' }}>
        {dayLabel(date)}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          ref={trackRef}
          className="lg-track"
          role="slider"
          tabIndex={0}
          aria-label="Hour of day"
          aria-valuemin={0}
          aria-valuemax={23}
          aria-valuenow={hour}
          aria-valuetext={`${String(hour).padStart(2, '0')}:00`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seek(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) seek(e.clientX);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') onHour(hour - 1);
            else if (e.key === 'ArrowRight') onHour(hour + 1);
            else return;
            e.preventDefault();
          }}
        >
          <div className="lg-track-fill" style={{ width: `${progressPercent(hour)}%` }} />
          <div className="lg-knob" style={{ left: `${progressPercent(hour)}%` }} />
        </div>
        <div className="lg-ticks">
          {ticks(hour).map((t) => (
            <span key={t.hour} className="lg-tick" data-active={t.active}>
              {t.label}
            </span>
          ))}
        </div>
      </div>

      <button type="button" className="lg-chip-button" onClick={onCycleStep} aria-label="Change step size">
        {STEPS[step]}
      </button>

      <button
        type="button"
        className="lg-chip-button"
        data-live={live}
        onClick={onLive}
        disabled={!isToday}
        title={isToday ? 'Jump to the current hour' : 'Only available for today'}
      >
        Live
      </button>
    </footer>
  );
}
