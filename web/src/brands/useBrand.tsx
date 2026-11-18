// The brand being viewed, shared by every screen. Fixed to Residential (see VIEW below).
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocations } from '../hooks';
import { brandsApi } from './api';
import { brandForLocation, brandsForLocations, type BrandSlug, type BrandView } from './rules';

// This portal is UrbanMop Residential. Commercial moved to the Luxoclean + Commercial portal,
// so there is no switch any more: every screen shows Residential, whatever a browser had
// chosen before.
const VIEW: BrandView = 'residential';

export function useBrandsData() {
  return useQuery({ queryKey: ['brands'], queryFn: brandsApi.get, staleTime: 5 * 60_000 });
}

export function useBrand() {
  const data = useBrandsData();
  const locations = useLocations();
  const view: BrandView = VIEW;
  const overrides = useMemo(() => data.data?.overrides || {}, [data.data]);
  const names = useMemo(() => new Map((locations.data || []).map((l) => [l.id, l.name])), [locations.data]);
  const brandOf = useCallback((id: number | null | undefined, name?: string | null): BrandSlug | null => brandForLocation(id, name ?? (id != null ? names.get(id) : null), overrides), [names, overrides]);
  const cleanerBrands = useCallback((ids: number[] | undefined) => brandsForLocations(ids, (id) => brandOf(id)), [brandOf]);
  // Loose on purpose while data loads or a record has no location: show it rather than hide it.
  const showLocation = useCallback((id: number | null | undefined, name?: string | null) => view === 'both' || id == null || brandOf(id, name) === view, [view, brandOf]);
  const showCleaner = useCallback((ids: number[] | undefined) => {
    if (view === 'both' || !ids?.length) return true;
    const b = cleanerBrands(ids);
    return !b.length || b.includes(view);
  }, [view, cleanerBrands]);
  // The viewed brand's Launch27 location ids, for server-side filters (null = both brands).
  const locationIds = useMemo(() => {
    if (view === 'both') return null;
    const ids = (locations.data || []).filter((l) => brandForLocation(l.id, l.name, overrides) === view).map((l) => l.id);
    return ids.length ? ids : [0]; // a brand with no locations matches nothing, not everything
  }, [view, locations.data, overrides]);
  const brands = data.data?.brands;
  const ready = !!data.data;
  return useMemo(
    () => ({ view, brands: brands || [], brandOf, cleanerBrands, showLocation, showCleaner, info: (slug: BrandSlug | null | undefined) => brands?.find((b) => b.slug === slug) || null, ready, locationIds }),
    [view, brands, brandOf, cleanerBrands, showLocation, showCleaner, ready, locationIds],
  );
}
