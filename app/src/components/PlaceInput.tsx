import { useEffect, useMemo, useRef, useState } from "react";
import { GAZETTEER, searchPlaces } from "../lib/geo";
import type { Place } from "../lib/types";

interface Props {
  id: string;
  label: string;
  value: Place | null;
  onPick: (p: Place) => void;
  recent: Place[];
  placeholder?: string;
}

/**
 * Async combobox. Debounced, abortable, keyboard-driven, and always showing
 * something: if Nominatim is unreachable the built-in gazetteer still answers.
 */
export default function PlaceInput({ id, label, value, onPick, recent, placeholder }: Props) {
  const [query, setQuery] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (value && value.name !== query) setQuery(value.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.name]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || (value && q === value.name)) {
      setRemote([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(async () => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      try {
        const found = await searchPlaces(q, { signal: ctrl.signal });
        setRemote(found);
      } catch {
        setRemote(GAZETTEER.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())));
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [query, value, onPick]);

  const list = useMemo(() => {
    if (remote.length) return remote;
    const q = query.trim().toLowerCase();
    const pool = q.length >= 2 ? [...recent, ...GAZETTEER].filter((p) => p.name.toLowerCase().includes(q)) : [...recent, ...GAZETTEER];
    const uniq: Place[] = [];
    for (const p of pool) {
      if (!uniq.some((u) => u.name === p.name)) uniq.push(p);
      if (uniq.length >= 6) break;
    }
    return uniq;
  }, [remote, query, recent]);

  const choose = (p: Place) => {
    onPick(p);
    setQuery(p.name);
    setOpen(false);
    setRemote([]);
  };

  return (
    <div className="field search" ref={boxRef}>
      <label htmlFor={id}>
        {label} {busy && <span className="pin">· searching…</span>}
      </label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        autoComplete="off"
        placeholder={placeholder ?? "Address, station, city…"}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (!open || !list.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % list.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + list.length) % list.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(list[Math.min(active, list.length - 1)]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <div className="suggest" id={`${id}-list`} role="listbox">
          {list.length === 0 ? (
            <div className="empty">{query.trim().length < 2 ? "Type at least 2 characters…" : "No match — try a wider place name."}</div>
          ) : (
            list.map((p, i) => (
              <button
                key={`${p.name}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(p)}
              >
                <span className="pin">{p.lat.toFixed(3)}, {p.lon.toFixed(3)}</span>{" "}
                {p.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
