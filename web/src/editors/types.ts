import type { Annotation, ClassDef, Item, Schema, ToolDef } from "../api/types";
import { classColor } from "../lib/format";
import type { Theme } from "../lib/palette";

/** Annotation with a client id, stable across autosaves. */
export interface Ann extends Annotation {
  cid: string;
}

export interface EditApi {
  add: (a: Ann) => void;
  /** Change one annotation. Inside a begin/commit transaction the change is folded into one undo step. */
  patch: (cid: string, fn: (a: Ann) => Ann) => void;
  remove: (cid: string) => void;
  setAll: (fn: (anns: Ann[]) => Ann[]) => void;
  begin: () => void;
  commit: () => void;
  cancel: () => void;
}

/** Read-only annotations from one annotator, drawn in review. */
export interface GhostLayer {
  key: string;
  name: string;
  color: string;
  anns: Annotation[];
}

export interface Pin {
  id: string;
  x?: number | null;
  y?: number | null;
  t?: number | null;
  annotation_id?: number | null;
  body: string;
  index: number;
}

export interface Anchor {
  x?: number;
  y?: number;
  t?: number;
  annotation_id?: number | null;
}

export interface EditorProps {
  item: Item;
  media: string | null;
  schema: Schema;
  anns: Ann[];
  ghosts?: GhostLayer[];
  selected: string | null;
  select: (cid: string | null) => void;
  /** "select", "pan", "comment", or a schema tool key. */
  mode: string;
  setMode: (m: string) => void;
  tool: ToolDef | null;
  activeClass: ClassDef | null;
  hidden: Set<string>;
  locked: Set<string>;
  edit: EditApi;
  theme: Theme;
  readOnly?: boolean;
  pins?: Pin[];
  onPin?: (a: Anchor) => void;
  /** Ghost annotation picked in review (to pin a comment to it). */
  onPickGhost?: (a: Annotation) => void;
  pickedGhostId?: number | null;
  /** Review only: draw each annotator's shapes in their own colour, or in the class colour. */
  ghostColorBy?: "annotator" | "class";
}

/** Colour of a review ghost annotation: its annotator's colour (default) or its class colour. */
export function ghostColor(g: GhostLayer, a: Annotation, schema: Schema, theme: Theme, by: "annotator" | "class" = "annotator"): string {
  return by === "class" ? classColor(schema, a.schema_key, a.label, theme) : g.color;
}

export function geomOf<T>(a: Annotation): T {
  return a.geometry as unknown as T;
}

export function toolFor(schema: Schema, key: string): ToolDef | undefined {
  return schema.tools.find((t) => t.key === key);
}
