import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { RouteResult } from "../lib/types";
import { humanDuration, round } from "../lib/util";

/**
 * Route map. Leaflet is bundled from npm (no CDN), markers use inline divIcons
 * so the default marker-image asset problem cannot occur, and a tile failure
 * degrades to a route-only canvas instead of a blank grey box.
 */

const LEGEND = [
  { color: "#38e1c0", label: "> 65 km/h" },
  { color: "#9ad86b", label: "45–65" },
  { color: "#ffcf5c", label: "30–45" },
  { color: "#ff9f68", label: "18–30" },
  { color: "#ff6b68", label: "< 18 crawling" },
];

export function speedColor(kmh: number): string {
  if (kmh >= 65) return "#38e1c0";
  if (kmh >= 45) return "#9ad86b";
  if (kmh >= 30) return "#ffcf5c";
  if (kmh >= 18) return "#ff9f68";
  return "#ff6b68";
}

interface Props {
  route: RouteResult;
  fromName: string;
  toName: string;
  /** Increments to force a re-fit when the trip changes. */
  tripKey: string;
}

export default function MapView({ route, fromName, toName, tripKey }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const firstFit = useRef<string>("");
  const [tilesOk, setTilesOk] = useState(true);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
      preferCanvas: true,
    });
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    let failures = 0;
    tiles.on("tileerror", () => {
      failures += 1;
      if (failures >= 3) setTilesOk(false);
    });
    tiles.on("tileload", () => setTilesOk(true));
    tiles.addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // Leaflet needs a size nudge when it mounts inside a flex/grid layout.
    setTimeout(() => map.invalidateSize(), 60);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const bounds = L.latLngBounds([]);
    for (const seg of route.segments.length ? route.segments : [{ coords: route.geometry, seconds: route.typicalSeconds, distanceM: route.distanceM, avgSpeedKmh: 0 }]) {
      if (seg.coords.length < 2) continue;
      const line = L.polyline(seg.coords as L.LatLngExpression[], {
        color: speedColor(seg.avgSpeedKmh),
        weight: 5.5,
        opacity: 0.92,
        lineJoin: "round",
      });
      if (seg.avgSpeedKmh > 0) {
        line.bindPopup(
          `<b>${Math.round(seg.avgSpeedKmh)} km/h</b> over ${round(seg.distanceM / 1000, 1)} km` +
            `<br/>${humanDuration(seg.seconds / 60)} in this stretch`,
        );
      }
      line.addTo(layer);
      for (const c of seg.coords) bounds.extend(c);
    }

    if (route.geometry.length) {
      L.polyline(route.geometry as L.LatLngExpression[], { color: "#ffffff", weight: 1, opacity: 0.25 }).addTo(layer);
      const a = route.geometry[0];
      const b = route.geometry[route.geometry.length - 1];
      L.marker(a, { icon: divIcon("A", "mk-a"), title: fromName }).addTo(layer).bindPopup(fromName);
      L.marker(b, { icon: divIcon("B", "mk-b"), title: toName }).addTo(layer).bindPopup(toName);
      bounds.extend(a).extend(b);
    }

    if (bounds.isValid()) {
      if (firstFit.current !== tripKey) {
        map.fitBounds(bounds, { padding: [34, 34] });
        firstFit.current = tripKey;
      }
    }
  }, [route, tripKey, fromName, toName]);

  return (
    <div className="map-shell">
      <div className="map" ref={hostRef} aria-label="Route map with congestion colouring" />
      {!tilesOk && (
        <div className="map-note">Basemap tiles blocked — route shape still drawn</div>
      )}
      <div className="map-legend">
        {LEGEND.map((l) => (
          <span key={l.label}>
            <i style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function divIcon(text: string, cls: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div class="mk ${cls}">${text}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}
