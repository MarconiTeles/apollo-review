import { useEffect, useState } from "react";
import Viewer from "./viewer/Viewer";
import { decodeInlinePayload, type ReviewPayload } from "./viewer/payload";
import "./App.css";

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; payload: ReviewPayload }
  | { phase: "error"; message: string };

export default function App() {
  const [state, setState] = useState<LoadState>({ phase: "idle" });

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const inline = p.get("z"); // self-contained review payload (no fetch → no CORS)
    const media = p.get("m"); // open a raw file for review (REVISAR entry point)
    const url = p.get("d") || p.get("data"); // legacy: fetch a JSON URL

    let cancelled = false;
    const ok = (payload: ReviewPayload) => {
      if (!cancelled) setState({ phase: "ready", payload });
    };
    const fail = (e: unknown) => {
      if (!cancelled)
        setState({
          phase: "error",
          message: e instanceof Error ? e.message : "Falha ao carregar o review.",
        });
    };

    if (inline) {
      setState({ phase: "loading" });
      decodeInlinePayload(inline).then(ok).catch(fail);
    } else if (media) {
      // Fresh review of a file: no payload yet, just the media + context.
      ok({
        taskId: p.get("task") ?? "",
        attachmentId: p.get("att") ?? "",
        uploaderId: p.get("up") ? Number(p.get("up")) : null,
        status: "in_review",
        summaryText: "",
        mediaUrl: media,
        ext: p.get("x") ?? media.split(".").pop() ?? "",
        mediaTitle: p.get("t") ?? "Arquivo",
        comments: [],
      });
    } else if (url) {
      setState({ phase: "loading" });
      fetch(url)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar o review.`);
          return (await r.json()) as ReviewPayload;
        })
        .then(ok)
        .catch(fail);
    } else {
      setState({ phase: "error", message: "Nenhum review especificado no link." });
    }
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
