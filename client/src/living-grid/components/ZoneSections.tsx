import { FlowsSection, KeyFigures, MixSection, NetSparkline, PriceBarsSection } from './PanelSections';
import { resolveNetSeries } from '../logic/netFromFlows';
import type { PanelTab } from '../logic/livingGridState';
import type { GridDay } from '@/types';

interface ZoneSectionsProps {
  day: GridDay;
  code: string;
  hour: number;
  ptab: PanelTab;
  onHour: (hour: number) => void;
  onPick: (code: string) => void;
  /** True when the reader asked for reduced motion: render the final state. */
  reduced: boolean;
}

/**
 * Which detail sections each panel tab shows.
 *
 * Overview is a superset, per the design: it carries the net-position
 * sparkline, the mix, the price profile and the flows together, while the
 * other three tabs each answer one question and close with the key figures.
 */
export function ZoneSections({ day, code, hour, ptab, onHour, onPick, reduced }: ZoneSectionsProps) {
  const zone = day.zones[code];
  const { series: netSeries } = resolveNetSeries(day, code);

  const showNet = ptab === 'Overview';
  const showMix = ptab === 'Overview' || ptab === 'Energy mix';
  const showPrice = ptab === 'Overview' || ptab === 'Prices';
  const showFlows = ptab === 'Overview' || ptab === 'Flows';

  return (
    <>
      {showNet && <NetSparkline series={netSeries} hour={hour} reduced={reduced} />}
      {showMix && <MixSection mix={zone?.mix} hour={hour} reduced={reduced} />}
      {showPrice && (
        <PriceBarsSection day={day} series={zone?.price} hour={hour} onHour={onHour} reduced={reduced} />
      )}
      {showFlows && <FlowsSection day={day} code={code} hour={hour} onPick={onPick} />}
      <KeyFigures day={day} code={code} hour={hour} netSeries={netSeries} reduced={reduced} />
    </>
  );
}
