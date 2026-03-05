import { useDashboardStore } from '@/store/dashboardStore';

const MAIN_TYPES = [
  { key: 'solar', label: 'Solar', color: '#F59E0B' },
  { key: 'wind_onshore', label: 'Wind Onshore', color: '#3B82F6' },
  { key: 'wind_offshore', label: 'Wind Offshore', color: '#0EA5E9' },
];

const OTHER_TYPES = ['hydro', 'biomass', 'geothermal'];

export function RenewableTypeToggles() {
  const { visibleRenewableTypes, toggleRenewableType, setVisibleRenewableTypes } = useDashboardStore();

  // Check if any "other" types are visible
  const showOthers = OTHER_TYPES.some((t) => visibleRenewableTypes.includes(t));

  const toggleOthers = () => {
    if (showOthers) {
      // Remove all other types
      setVisibleRenewableTypes(visibleRenewableTypes.filter((t) => !OTHER_TYPES.includes(t)));
    } else {
      // Add all other types
      setVisibleRenewableTypes([...visibleRenewableTypes, ...OTHER_TYPES]);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {MAIN_TYPES.map((type) => {
        const isVisible = visibleRenewableTypes.includes(type.key);
        return (
          <button
            key={type.key}
            onClick={() => toggleRenewableType(type.key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all ${
              isVisible
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'bg-muted text-muted-foreground border border-transparent opacity-50 hover:opacity-100'
            }`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: isVisible ? type.color : 'currentColor' }}
            />
            {type.label}
          </button>
        );
      })}
      {/* Other types toggle */}
      <button
        onClick={toggleOthers}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all ${
          showOthers
            ? 'bg-primary/10 text-primary border border-primary/20'
            : 'bg-muted text-muted-foreground border border-transparent opacity-50 hover:opacity-100'
        }`}
        title="Hydro, Biomass, Geothermal"
      >
        <span className="h-2 w-2 rounded-full bg-current" />
        Other
      </button>
    </div>
  );
}
