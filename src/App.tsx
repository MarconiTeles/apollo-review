import { useEffect, useState } from "react";
import Viewer from "./viewer/Viewer";
import type { ReviewPayload } from "./viewer/payload";
import "./App.css";

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; payload: ReviewPayload }
  | { phase: "error"; message: string };

/** Read the review JSON URL from the query string (?d=...). */
function jsonUrlFromLocation(): string | null {
  const p = new URLSearchParams(window.location.search);
  return p.get("d") || p.get("data") || null;
}

export default function App() {
  const [state, setState] = useState<LoadState>({ phase: "idle" });

  useEffect(() => {
    const url = jsonUrlFromLocation();
    if (!url) {
      setState({ phase: "error", message: "Nenhum review especificado (falta o parâmetro ?d=)." });
      return;
    }
    let cancelled = false;
    setState({ phase: "loading" });
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar o review.`);
        return (await r.json()) as ReviewPayload;
      })
      .then((payload) => {
        if (!cancelled) setState({ phase: "ready", payload });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setState({
            phase: "error",
            message: e instanceof Error ? e.message : "Falha ao carregar o review.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "ready") return <Viewer payload={state.payload} />;

  return (
    <div className="vw-splash">
      <div className="vw-splash-card">
        <span className="vw-brand">Apollo Review</span>
        {state.phase === "loading" && <p className="vw-muted">Carregando review…</p>}
        {state.phase === "error" && (
          <>
            <p className="vw-err">{state.message}</p>
            <p className="vw-muted">
              Abra este visualizador a partir do link gerado pelo Apollo.
            </p>
          </>
        )}
        {state.phase === "idle" && <p className="vw-muted">Carregando…</p>}
      </div>
    </div>
  );
}
