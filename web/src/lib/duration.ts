// A booking's recommended duration, worked out the way Launch27's booking form does: each
// service's base time, plus each extra's time, plus each pricing parameter's time × quantity
// (e.g. 2 full bathrooms). Launch27 shows this as "(recommended)" next to the manual duration.
export interface CatalogService { id: number; duration?: number | null; extras?: { id: number; duration?: number | null; quantity_based?: boolean }[] | null }
export interface CatalogParam { id: number; duration?: number | null }
export interface BookedService { id: number; extras?: { id: number; quantity?: number | null }[] | null; pricing_parameters?: { id: number; quantity?: number | null }[] | null }

export function recommendedMinutes(booked: BookedService[] = [], services: CatalogService[] = [], params: CatalogParam[] = []): { minutes: number; complete: boolean } | null {
  if (!booked.length) return null;
  const svcById = new Map(services.map((s) => [Number(s.id), s]));
  const paramById = new Map(params.map((p) => [Number(p.id), p]));
  let minutes = 0;
  let complete = true; // false when some piece has no time in the catalog
  for (const b of booked) {
    const svc = svcById.get(Number(b.id));
    if (!svc || svc.duration == null) {
      complete = false;
      continue;
    }
    minutes += Number(svc.duration) || 0;
    for (const x of b.extras || []) {
      const def = svc.extras?.find((e) => Number(e.id) === Number(x.id));
      if (!def || def.duration == null) {
        complete = false;
        continue;
      }
      minutes += (Number(def.duration) || 0) * (def.quantity_based ? Number(x.quantity) || 1 : 1);
    }
    for (const p of b.pricing_parameters || []) {
      const qty = Number(p.quantity) || 0;
      if (!qty) continue;
      const def = paramById.get(Number(p.id));
      if (!def || def.duration == null) {
        complete = false;
        continue;
      }
      minutes += (Number(def.duration) || 0) * qty;
    }
  }
  return { minutes, complete };
}

// How many cleaners a job of this length usually needs: one up to 7 h, two up to 10.5 h, then three.
export function crewFor(minutes: number): number {
  if (minutes < 7 * 60) return 1;
  if (minutes < 10.5 * 60) return 2;
  return 3;
}
