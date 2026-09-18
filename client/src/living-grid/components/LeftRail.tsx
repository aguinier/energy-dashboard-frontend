import type { ColourBy, LayerToggles, VizToggles } from '../logic/livingGridState';

interface ToggleRowProps {
  label: string;
  on: boolean;
  onToggle: () => void;
}

function ToggleRow({ label, on, onToggle }: ToggleRowProps) {
  return (
    <button type="button" className="lg-toggle" aria-pressed={on} onClick={onToggle}>
      <span className="lg-toggle-track">
        <span className="lg-toggle-knob" />
      </span>
      <span className="lg-toggle-text">{label}</span>
    </button>
  );
}

const LAYER_ROWS: { key: keyof LayerToggles; label: string }[] = [
  { key: 'net', label: 'Net position' },
  { key: 'flows', label: 'Cross-border flows' },
  { key: 'commercial', label: 'Commercial exchange' },
  { key: 'grid', label: 'Transmission grid' },
  { key: 'plants', label: 'Power plants' },
];

const VIZ_ROWS: { key: keyof VizToggles; label: string }[] = [
  { key: 'anim', label: 'Flow animation' },
  { key: 'values', label: 'Values' },
  { key: 'labels', label: 'Labels' },
  { key: 'glow', label: 'Coastline glow' },
  { key: 'borders', label: 'Borders' },
];

interface LeftRailProps {
  colourBy: ColourBy;
  onColourBy: (colourBy: ColourBy) => void;
  layers: LayerToggles;
  onLayer: (key: keyof LayerToggles) => void;
  viz: VizToggles;
  onViz: (key: keyof VizToggles) => void;
}

export function LeftRail({ colourBy, onColourBy, layers, onLayer, viz, onViz }: LeftRailProps) {
  return (
    <aside className="lg-rail">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
        <div className="lg-label">Colour by</div>
        <div className="lg-segmented">
          <button type="button" aria-pressed={colourBy === 'net'} onClick={() => onColourBy('net')}>
            Net position
          </button>
          <button type="button" aria-pressed={colourBy === 'price'} onClick={() => onColourBy('price')}>
            Price
          </button>
        </div>
      </div>

      <div className="lg-divider" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
        <div className="lg-label">Layers</div>
        {LAYER_ROWS.map((row) => (
          <ToggleRow key={row.key} label={row.label} on={layers[row.key]} onToggle={() => onLayer(row.key)} />
        ))}
      </div>

      <div className="lg-divider" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
        <div className="lg-label">Visualization</div>
        {VIZ_ROWS.map((row) => (
          <ToggleRow key={row.key} label={row.label} on={viz[row.key]} onToggle={() => onViz(row.key)} />
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <div className="lg-tagline">
        A CLEANER,
        <br />
        STRONGER,
        <br />
        MORE CONNECTED
        <br />
        EUROPE
      </div>
    </aside>
  );
}
