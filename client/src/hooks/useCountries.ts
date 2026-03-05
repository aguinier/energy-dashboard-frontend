import { useQuery } from '@tanstack/react-query';
import { fetchCountries, fetchCountriesWithData } from '@/services/api';

export function useCountries() {
  return useQuery({
    queryKey: ['countries'],
    queryFn: fetchCountries,
    staleTime: 1000 * 60 * 60, // 1 hour
  });
}

export function useCountriesWithData() {
  return useQuery({
    queryKey: ['countries', 'with-data'],
    queryFn: fetchCountriesWithData,
    staleTime: 1000 * 60 * 60, // 1 hour
  });
}
