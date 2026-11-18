// The small brand label used across screens.
import { useBrand } from './useBrand';
import type { BrandSlug } from './rules';

const SHORT: Record<BrandSlug, string> = { residential: 'Residential', commercial: 'Commercial' };

// A label for one record's brand. "shared" for cleaners working in both.
export function BrandPill({ brand, shared = false, always = false }: { brand: BrandSlug | null | undefined; shared?: boolean; always?: boolean }) {
  const { view } = useBrand();
  if (shared) return <span className="brand-pill shared">Shared · both brands</span>;
  if (!brand) return always ? <span className="brand-pill none">No brand</span> : null;
  // On a single-brand view everything is that brand: the label only adds noise.
  if (!always && view !== 'both') return null;
  return <span className={`brand-pill ${brand}`}>{SHORT[brand]}</span>;
}

export function brandLabel(view: 'residential' | 'commercial' | 'both') {
  return view === 'both' ? 'Both brands' : `UrbanMop ${SHORT[view]}`;
}

// On one brand's view: flags a customer who also books the other brand now.
export function AlsoOtherBrand({ locationIds }: { locationIds?: number[] }) {
  const { view, brandOf } = useBrand();
  if (view === 'both' || !locationIds?.length) return null;
  const other = locationIds.map((id) => brandOf(id)).find((b) => b && b !== view);
  return other ? <span className={`brand-pill ${other}`} title="Has current bookings in the other brand too">Also {SHORT[other]}</span> : null;
}
