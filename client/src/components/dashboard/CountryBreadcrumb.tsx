import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';

// Slim breadcrumb at the top of the country page: a back link to the map
// followed by a native <select> for jumping straight to another country.
export function CountryBreadcrumb() {
  const { selectedCountry, setSelectedCountry, goToMap } = useDashboardStore();
  const { data: countries } = useCountries();

  return (
    <div className="mb-3.5 flex items-center gap-2">
      <button
        onClick={goToMap}
        className="cursor-pointer border-none bg-transparent p-0 text-[12px] text-ink-dim hover:text-foreground"
      >
        ← Map
      </button>
      <span className="text-[12px] text-ink-faint">/</span>
      <select
        value={selectedCountry}
        onChange={(e) => setSelectedCountry(e.target.value)}
        className="cursor-pointer border-none bg-transparent p-0 text-[12px] text-ink-dim hover:text-foreground"
      >
        {countries?.map((c) => (
          <option key={c.country_code} value={c.country_code}>
            {c.country_name}
          </option>
        ))}
      </select>
    </div>
  );
}
