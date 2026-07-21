import { useEffect, useState } from "react";
import Editor from "./viewer/Editor";
import { decodeInlinePayload, mediaKindFor, type ReviewPayload } from "./viewer/payload";
import {
  resolveSession,
  WORKER_URL,
  type SessionContext,
} from "./contract/session";
import "./App.css";

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; payload: ReviewPayload; edit: boolean; session?: SessionContext }
  | { phase: "error"; message: string };

export default function App() {
  const [state, setState] = useState<LoadState>({ phase: "idle" });

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const inline = p.get("z"); // legacy self-contained payload (immutable link)
    const att = p.get("att"); // server-backed review, keyed by attachment
    const media = p.get("m"); // raw media to review
    const url = p.get("d") || p.get("data"); // legacy: fetch a JSON URL

    let cancelled = false;
    const ok = (payload: ReviewPayload, edit = false, session?: SessionContext) => {
      if (!cancelled) setState({ phase: "ready", payload, edit, session });
    };
    const mediaWidth = numParam(p, "mediaWidth") ?? numParam(p, "width") ?? numParam(p, "w");
    const mediaHeight = numParam(p, "mediaHeight") ?? numParam(p, "height") ?? numParam(p, "h");
    const fail = (e: unknown) => {
      if (!cancelled)
        setState({
          phase: "error",
          message: e instanceof Error ? e.message : "Falha ao carregar o review.",
        });
    };

    if (inline) {
      // Old "VER REVIEW" links posted before the server backend existed.
      setState({ phase: "loading" });
      decodeInlinePayload(inline).then((pl) => ok(pl)).catch(fail);
    } else if (att && media && WORKER_URL) {
      // ── The single live link. Same URL for "revisar" and "ver": it resolves
      //    to the KV blob for this attachment and stays editable. ──
      setState({ phase: "loading" });
      const ext = p.get("x") ?? media.split(".").pop() ?? "";
      resolveSession({
        taskId: p.get("task") ?? "",
        listId: p.get("list"),
        attachmentId: att,
        mediaUrl: media,
        mediaTitle: p.get("t") ?? "Arquivo",
        mediaKind: mediaKindFor(ext),
        uploaderId: p.get("up") ? Number(p.get("up")) : null,
        createdById: p.get("by") ? Number(p.get("by")) : null,
        actorId: p.get("actor") ? Number(p.get("actor")) : null,
      })
        .then((res) =>
          ok(
            {
              taskId: p.get("task") ?? "",
              attachmentId: att,
              versionId: res.versionId,
              commentId: p.get("cmt") ?? null,
              uploaderId: p.get("up") ? Number(p.get("up")) : null,
              uploaderName: p.get("un") ?? null,
              status: res.status,
              summaryText: "",
              mediaUrl: res.mediaUrl || media,
              ext: res.ext || ext,
              mediaTitle: res.mediaTitle || p.get("t") || "Arquivo",
              mediaWidth,
              mediaHeight,
              comments: res.comments,
            },
            true,
            {
              reviewId: res.reviewId,
              versionId: res.versionId,
              versions: res.versions,
              versionStates: res.versionStates,
            },
          ),
        )
        .catch(fail);
    } else if (media) {
      // Legacy fresh review of a file with no backend → local editor only.
      ok(
        {
          taskId: p.get("task") ?? "",
          attachmentId: p.get("att") ?? "",
          commentId: p.get("cmt") ?? null,
          uploaderId: p.get("up") ? Number(p.get("up")) : null,
          uploaderName: p.get("un") ?? null,
          status: "in_review",
          summaryText: "",
          mediaUrl: media,
          ext: p.get("x") ?? media.split(".").pop() ?? "",
          mediaTitle: p.get("t") ?? "Arquivo",
          mediaWidth,
          mediaHeight,
          comments: [],
        },
        true,
      );
    } else if (url) {
      setState({ phase: "loading" });
      fetch(url)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar o review.`);
          return (await r.json()) as ReviewPayload;
        })
        .then((pl) => ok(pl))
        .catch(fail);
    } else {
      setState({ phase: "error", message: "Nenhum review especificado no link." });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "ready")
    return (
      <Editor
        payload={state.payload}
        readOnly={!state.edit}
        session={state.session}
      />
    );

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

function numParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
