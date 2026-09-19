import { useEffect, useRef } from 'react';
import { STEPS } from '../logic/livingGridState';
import { hourAtPosition, progressPercent, ticks } from '../logic/timeline';
import { canStepDay, relativeDayLabel } from '../logic/dayRange';
import { dayLabel, hourLabel } from '../logic/format';

interface FooterTimelineProps {
  hour: number;
  playing: boolean;
  step: number;
  /** The day on screen. */
  date: string;
  /** Today, whatever day is on screen — the anchor the arrows measure against. */
  today: string;
  /**
   * True while the map still shows the previous day. The label leads the map by
   * one fetch, and dimming it is how that beat is admitted rather than hidden.
   */
  pending: boolean;
  /**
   * Whether the view is on now — today's date AND the current hour. Computed by
   * the view, not here: during a pending step the payload's `isToday` still
   * describes the day being left, and would light this on the way out of today.
   */
  live: boolean;
  /**
   * `via` tells the map whether this is a step worth easing. A scrub is the
   * reader steering and snaps; the arrow keys step and ease.
   */
  onHour: (hour: number, via?: 'drag' | 'step') => void;
  onTogglePlay: () => void;
  onCycleStep: () => void;
  onLive: () => void;
  onStepDay: (delta: number) => void;
}

export function FooterTimeline({
  hour,
  playing,
  step,
  date,
  today,
  pending,
  live,
  onHour,
  onTogglePlay,
  onCycleStep,
  onLive,
  onStepDay,
}: FooterTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingX = useRef<number | null>(null);

  const seek = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    onHour(hourAtPosition(clientX - rect.left, rect.width), 'drag');
  };

  /**
   * One seek per frame, not one per pointer event.
   *
   * A drag fires pointermove far faster than the screen refreshes, and each one
   * read layout (`getBoundingClientRect`) and dispatched — while the map element
   * runs its own animation loop in the same thread. Only the last position in a
   * frame can be seen, so the rest was work nobody could observe.
   */
  const scheduleSeek = (clientX: number) => {
    pendingX.current = clientX;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (pendingX.current !== null) seek(pendingX.current);
    });
  };

  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

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

      <div className="lg-day" role="group" aria-label="Day">
        <button
          type="button"
          className="lg-day-step"
          onClick={() => onStepDay(-1)}
          disabled={!canStepDay(date, today, -1)}
          aria-label="Previous day"
        >
          ‹
        </button>
        {/*
          The live region sits on the label, not on the buttons: after a step
          focus stays on the arrow and nothing focused has changed, so without
          it a screen-reader user gets silence where the whole view just moved.
        */}
        <div className="lg-day-label" data-pending={pending} aria-live="polite">
          <div className="lg-day-date">{dayLabel(date)}</div>
          <div className="lg-day-rel">{relativeDayLabel(date, today)}</div>
        </div>
        <button
          type="button"
          className="lg-day-step"
          onClick={() => onStepDay(1)}
          disabled={!canStepDay(date, today, 1)}
          aria-label="Next day"
        >
          ›
        </button>
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
          aria-valuetext={`${dayLabel(date)} ${hourLabel(hour)}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seek(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) scheduleSeek(e.clientX);
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

      {/*
        Never disabled. This is the way back from a pinned day, so disabling it
        off today — as it once was — put the exit behind the door it unlocks.
        `data-live` already says teal when you are on now, and GO_LIVE returns
        the same state reference when nothing would change, so a redundant
        press is free.
      */}
      <button
        type="button"
        className="lg-chip-button"
        data-live={live}
        onClick={onLive}
        title="Jump to today at the current hour"
      >
        Live
      </button>
    </footer>
  );
}
