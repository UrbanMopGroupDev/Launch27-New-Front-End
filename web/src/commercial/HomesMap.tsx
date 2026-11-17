// Commercial › Workforce plan › Where cleaners live: shades the postal area each cleaner lives in,
// to pick someone close to a client. Only the postal area (first 3 characters of the home postal
// code entered on the Commercial team tab) is shown, never an address.
//
// The outlines (~230 KB, ~60 KB compressed) are in web/public/geo/postal-areas.json and are only
// downloaded when this tab opens, so the rest of the portal stays fast.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Scope, TeamRow } from './workforceApi';
import { workforceApi } from './workforceApi';

interface PostalAreas {
  credit: string;
  /** FSA -> [lat, lng, place name] */
  centres: Record<string, [number, number, string]>;
  /** FSA -> rings of [lng, lat] */
  shapes: Record<string, [number, number][][]>;
}
type Region = 'ottawa' | 'cornwall' | 'all';
const REGIONS: [Region, string][] = [['ottawa', 'Ottawa'], ['cornwall', 'Cornwall'], ['all', 'All areas']];
// Same split as the slot finder: east of 75.05° W is the Cornwall side.
const inRegion = (r: Region, lng: number) => r === 'all' || (r === 'cornwall' ? lng >= -75.05 : lng < -75.05);
const shortName = (n: string) => {
  const w = n.split(' ');
  return w[0] + (w.length > 1 ? ` ${w[w.length - 1].charAt(0)}.` : '');
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function loadAreas(): Promise<PostalAreas> {
  const res = await fetch('/geo/postal-areas.json');
  if (!res.ok) throw new Error(`Could not load the postal-area map (${res.status}).`);
  return res.json();
}

export function HomesTab({ scope }: { scope: Scope }) {
  const team = useQuery({ queryKey: ['commercial', 'workforce', 'team', scope], queryFn: () => workforceApi.team(scope), retry: false });
  const areas = useQuery({ queryKey: ['geo', 'postal-areas'], queryFn: loadAreas, staleTime: Infinity, gcTime: Infinity, retry: 1 });
  const [picked, setPicked] = useState<number[] | null>(null); // null = everyone with a home postal code
  const [region, setRegion] = useState<Region>('ottawa');

  const cleaners = useMemo(() => [...(team.data?.cleaners || [])].sort((a, b) => Number(b.commercial) - Number(a.commercial) || a.name.localeCompare(b.name)), [team.data]);
  const withHome = cleaners.filter((c) => c.home_fsa);
  const sel = picked ?? withHome.map((c) => c.id);
  const shown = withHome.filter((c) => sel.includes(c.id));
  const byArea = useMemo(() => {
    const m = new Map<string, TeamRow[]>();
    for (const c of shown) m.set(c.home_fsa!, [...(m.get(c.home_fsa!) || []), c]);
    return m;
  }, [shown]);
  const missing = cleaners.length - withHome.length;
  const outside = areas.data ? [...byArea.keys()].filter((k) => areas.data.centres[k] && !inRegion(region, areas.data.centres[k][1])) : [];

  if (team.isError) return <div className="card error">{(team.error as Error).message}</div>;
  if (!team.data) return <div className="muted">Loading…</div>;

  const toggle = (id: number) => setPicked(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const tick = (c: TeamRow) => (
    <label key={c.id} className={`wf-hpick${c.home_fsa ? '' : ' nohome'}`}>
      <input type="checkbox" checked={!!c.home_fsa && sel.includes(c.id)} disabled={!c.home_fsa} onChange={() => toggle(c.id)} />
      <span>{c.name}</span>
      {c.home_fsa ? <span className="chip wf-home-chip">⌂ {c.home_fsa}</span> : <span className="chip muted" title="Add a home postal code on the Commercial team tab">no home postal code</span>}
    </label>
  );
  const com = cleaners.filter((c) => c.commercial);
  const other = cleaners.filter((c) => !c.commercial);

  return (
    <section className="card no-pad">
      <div className="wf-head"><h2>Where cleaners live <span className="muted">· {shown.length} of {withHome.length} shown</span></h2></div>
      <p className="muted small wf-note">See which part of the city each cleaner lives in, to pick someone close to a client. Only the postal area (first 3 characters of the postal code) is shown, never a street address. Home postal codes are entered on the Commercial team tab and never go into partner files.</p>
      <div className="wf-hpanel">
        <div className="wf-hrow">
          <strong>Choose cleaners</strong>
          <button type="button" className="secondary" onClick={() => setPicked(null)}>Show all</button>
          <button type="button" className="secondary" onClick={() => setPicked([])}>Clear</button>
          <select value={region} aria-label="Area" onChange={(e) => setRegion(e.target.value as Region)}>
            {REGIONS.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
          </select>
        </div>
        {com.length > 0 && <><div className="muted small">Commercial team</div><div className="wf-hlist">{com.map(tick)}</div></>}
        {other.length > 0 && (
          <details open={other.some((c) => c.home_fsa && sel.includes(c.id))}>
            <summary className="small">Other cleaners with Commercial work ({other.length})</summary>
            <div className="wf-hlist">{other.map(tick)}</div>
          </details>
        )}
        {missing > 0 && <p className="muted small">{missing} cleaner{missing === 1 ? ' has' : 's have'} no home postal code yet. Add it on the Commercial team tab, under Cleaner details.</p>}
        {withHome.length > 0 && !shown.length && <p className="muted small">Nobody is selected. Tick a cleaner or press Show all.</p>}
        {outside.length > 0 && <p className="muted small">{outside.length} home area{outside.length === 1 ? ' is' : 's are'} outside this view ({outside.join(', ')}): choose “All areas”.</p>}
      </div>
      {areas.isError && <div className="card error">{(areas.error as Error).message}</div>}
      {!areas.data && areas.isLoading && <div className="muted wf-empty">Loading the map…</div>}
      {areas.data && <AreaMap data={areas.data} byArea={byArea} region={region} />}
      {byArea.size > 0 && (
        <div className="wf-scroll"><table>
          <thead><tr><th>Home area</th><th>Place</th><th>Who lives there</th></tr></thead>
          <tbody>
            {[...byArea.keys()].sort().map((k) => (
              <tr key={k}><td className="mono">{k}</td><td>{areas.data?.centres[k]?.[2] || ''}</td><td>{byArea.get(k)!.map((c) => c.name).join(', ')}</td></tr>
            ))}
          </tbody>
        </table></div>
      )}
      {areas.data && <p className="muted small wf-note">{areas.data.credit} Map tiles © OpenStreetMap contributors.</p>}
    </section>
  );
}

function AreaMap({ data, byArea, region }: { data: PostalAreas; byArea: Map<string, TeamRow[]>; region: Region }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, scrollWheelZoom: false }).setView([45.4215, -75.6972], 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const focus: L.LatLngExpression[] = [];
    const regionPts: L.LatLngExpression[] = [];
    for (const [k, rings] of Object.entries(data.shapes)) {
      const c = data.centres[k];
      if (!c || !inRegion(region, c[1])) continue;
      const latlngs = rings.map((r) => r.map(([lng, lat]) => [lat, lng] as L.LatLngTuple));
      const home = byArea.get(k);
      const names = home?.map((x) => x.name) || [];
      const poly = L.polygon(latlngs, home
        ? { color: '#15803d', weight: 2, fillColor: '#22c55e', fillOpacity: 0.35 }
        : { color: '#64748b', weight: 1, fillOpacity: 0.03, dashArray: '3 3' });
      poly.bindTooltip(esc(`${k} · ${c[2]}${names.length ? ` · lives here: ${names.join(', ')}` : ''}`), { sticky: true });
      poly.addTo(g);
      regionPts.push([c[0], c[1]]);
      if (home) {
        // Label at the middle of the area's largest outline piece (the GeoNames centre can fall outside the shape).
        const box = (r: L.LatLngTuple[]) => L.latLngBounds(r);
        const size = (b: L.LatLngBounds) => (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
        const biggest = latlngs.map(box).reduce((a, b) => (size(b) > size(a) ? b : a));
        const short = names.map(shortName);
        const label = `⌂ ${k} · ${short.length > 3 ? `${short.slice(0, 3).join(', ')} +${short.length - 3}` : short.join(', ')}`;
        L.marker(biggest.getCenter(), { icon: L.divIcon({ className: 'wf-home-label', html: `<span>${esc(label)}</span>`, iconSize: undefined }), keyboard: false })
          .bindTooltip(esc(`${k} · ${c[2]} · ${names.join(', ')}`))
          .addTo(g);
        const all = poly.getBounds();
        focus.push(all.getSouthWest(), all.getNorthEast());
      }
    }
    const pts = focus.length >= 2 ? focus : regionPts;
    if (pts.length) m.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 13, animate: false });
  }, [data, byArea, region]);

  return <div ref={el} className="route-map wf-homes-map" style={{ height: 520 }} />;
}
