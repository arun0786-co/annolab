import { useState } from "react";
import { api } from "../api/client";
import type { ExportFormat, Project } from "../api/types";
import { fmtBytes } from "../lib/format";
import { Dialog } from "./Dialog";

const FORMATS: { id: ExportFormat; name: string; desc: string; modalities: string[] }[] = [
  { id: "coco", name: "COCO JSON", desc: "Images, categories and annotations (bbox, segmentation polygons, keypoints).", modalities: ["image"] },
  { id: "yolo", name: "YOLO", desc: "Zip with one .txt per image (class cx cy w h, normalised) and classes.txt.", modalities: ["image"] },
  { id: "jsonl", name: "JSONL", desc: "One line per item with every annotation, review state and attributes. Works for all modalities.", modalities: ["image", "audio", "video", "text"] },
];

export function ExportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const supported = FORMATS.filter((f) => f.modalities.includes(project.modality));
  const [format, setFormat] = useState<ExportFormat>(supported[0]?.id ?? "jsonl");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; name: string; size: number } | { kind: "error"; msg: string }>({
    kind: "idle",
  });
  async function run() {
    setState({ kind: "busy" });
    try {
      const { blob, filename } = await api.exportBlob(project.id, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState({ kind: "done", name: filename, size: blob.size });
    } catch (e) {
      setState({ kind: "error", msg: (e as Error).message });
    }
  }
  return (
    <Dialog
      title={`Export ${project.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={run} disabled={state.kind === "busy"}>
            {state.kind === "busy" ? "Preparing" : "Download"}
          </button>
        </>
      }
    >
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <legend className="muted" style={{ marginBottom: 8 }}>
          Format
        </legend>
        {FORMATS.map((f) => {
          const ok = f.modalities.includes(project.modality);
          return (
            <label
              key={f.id}
              className="panel"
              style={{ display: "flex", gap: 12, padding: 12, cursor: ok ? "pointer" : "default", opacity: ok ? 1 : 0.5, borderColor: format === f.id ? "var(--accent)" : undefined }}
            >
              <input type="radio" name="fmt" value={f.id} checked={format === f.id} disabled={!ok} onChange={() => setFormat(f.id)} />
              <span className="stack" style={{ gap: 2 }}>
                <strong>{f.name}</strong>
                <span className="muted">{f.desc}</span>
                {!ok && <span className="faint">Not available for {project.modality} projects.</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="faint" style={{ marginTop: 12 }}>
        Includes submitted annotations. Items with a reviewer decision carry it in the export.
      </p>
      <div aria-live="polite" style={{ marginTop: 8 }}>
        {state.kind === "done" && (
          <span className="badge badge-good">
            Downloaded {state.name} ({fmtBytes(state.size)})
          </span>
        )}
        {state.kind === "error" && <div className="alert">{state.msg}</div>}
      </div>
    </Dialog>
  );
}
