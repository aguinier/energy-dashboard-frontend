import { useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';
import { cn } from '@/lib/utils';

export function CountrySelector() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { selectedCountry, setSelectedCountry } = useDashboardStore();
  const { data: countries, isLoading } = useCountries();

  const selectedCountryData = countries?.find(
    (c) => c.country_code === selectedCountry
  );

  const filteredCountries = countries?.filter(
    (c) =>
      c.country_name.toLowerCase().includes(search.toLowerCase()) ||
      c.country_code.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[180px] justify-between"
          disabled={isLoading}
        >
          {selectedCountryData ? (
            <span className="flex items-center gap-2">
              <span className="font-mono text-xs">{selectedCountryData.country_code}</span>
              <span className="hidden sm:inline truncate">
                {selectedCountryData.country_name}
              </span>
            </span>
          ) : (
            'Select country...'
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="end">
        {/* Search input */}
        <div className="flex items-center border-b px-3 py-2">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            placeholder="Search countries..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        {/* Country list */}
        <div className="max-h-[300px] overflow-auto p-1">
          {filteredCountries?.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              No countries found.
            </p>
          ) : (
            filteredCountries?.map((country) => (
              <button
                key={country.country_code}
                onClick={() => {
                  setSelectedCountry(country.country_code);
                  setOpen(false);
                  setSearch('');
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground',
                  selectedCountry === country.country_code && 'bg-accent'
                )}
              >
                <span className="w-8 font-mono text-xs text-muted-foreground">
                  {country.country_code}
                </span>
                <span className="flex-1 text-left">{country.country_name}</span>
                {selectedCountry === country.country_code && (
                  <Check className="h-4 w-4" />
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
