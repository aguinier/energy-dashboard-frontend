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
 */
export function Figure({ number, anchorId, title, caption, footnote, children }: Props) {
  return (
    <figure
      id={`figure-${anchorId}`}
      className="m-0 flex scroll-mt-20 flex-col gap-3.5 border-t border-border pb-7 pt-6"
    >
      <div className="flex flex-col gap-1">
        <div className="text-label uppercase text-ink-muted">Figure {number}</div>
        <h2 className="m-0 text-title font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </h2>
        <p className="m-0 max-w-[74ch] text-body text-ink-dim [text-wrap:pretty]">
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
