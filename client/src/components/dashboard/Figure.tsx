import type { ReactNode } from 'react';

interface Props {
  /** Figures are cited by number in captions and in cross-links. */
  number: number;
  /** Stable id for scroll-to-figure. Rendered as `figure-<anchorId>`. */
  anchorId: string;
  title: string;
  caption: string;
  /** Provenance, accuracy badge, stated absences. Omitted entirely if absent. */
  footnote?: ReactNode;
  children: ReactNode;
}

/**
 * One figure in the country document: number, title, caption, plot, footnote.
 *
 * The caption says what the figure shows and why it is here — it is not a
 * restatement of the title. The footnote is where a claim about the data goes,
 * including the claim that something is missing.
 *
 * A `<figure>` takes its accessible name from `<figcaption>` by default, and
 * the footnote — provenance, the accuracy badge — lives there for the visual
 * design (a below-plot line, deliberately separate from the above-plot
 * description; that split stays). Left alone, that would announce this figure
 * by its source attribution rather than by what it shows. `aria-labelledby`
 * overrides the name to the title instead, and `aria-describedby` associates
 * the descriptive sentence as the figure's accessible description, so a
 * screen-reader user hears both — title as name, caption as description —
 * without changing what a sighted reader sees.
 */
export function Figure({ number, anchorId, title, caption, footnote, children }: Props) {
  const titleId = `figure-${anchorId}-title`;
  const captionId = `figure-${anchorId}-caption`;
  return (
    <figure
      id={`figure-${anchorId}`}
      aria-labelledby={titleId}
      aria-describedby={captionId}
      className="m-0 flex scroll-mt-20 flex-col gap-3.5 border-t border-border pb-7 pt-6"
    >
      <div className="flex flex-col gap-1">
        <div className="text-label uppercase text-ink-muted">Figure {number}</div>
        <h2 id={titleId} className="m-0 text-title font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </h2>
        <p id={captionId} className="m-0 max-w-[74ch] text-body text-ink-dim [text-wrap:pretty]">
          {caption}
        </p>
      </div>
      {children}
      {footnote ? (
        <figcaption className="flex flex-wrap items-baseline gap-2.5 text-meta text-ink-muted">
          {footnote}
        </figcaption>
      ) : null}
    </figure>
  );
}
