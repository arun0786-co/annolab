// Schema validation shared by the schema editor. Pure so it can be unit tested.
import type { Modality, Schema } from "../api/types";
import { contrast, PALETTE_LIGHT, SURFACE_DARK, SURFACE_LIGHT, displayColor } from "./palette";

const ALLOWED: Record<Modality, string[]> = {
  image: ["bbox", "polygon", "point"],
  audio: ["segment"],
  video: ["track", "segment"],
  text: ["span"],
};

export interface Issue {
  level: "error" | "warn";
  path: string;
  msg: string;
}

const KEY_RE = /^[a-z0-9_][a-z0-9_-]*$/i;

export function validateSchema(s: Schema, modality: Modality): Issue[] {
  const out: Issue[] = [];
  const keys = new Set<string>();
  const dupKey = (k: string, path: string) => {
    if (keys.has(k)) out.push({ level: "error", path, msg: `Key "${k}" is used twice` });
    keys.add(k);
  };
  // colour -> class value, across the whole schema: one hue per concept, whatever the tool.
  const colorOwner = new Map<string, string>();
  if (!s.tools.length && !s.classifications.length) out.push({ level: "warn", path: "", msg: "Add at least one tool or classification" });
  s.tools.forEach((t, ti) => {
    const p = `tools.${ti}`;
    if (!t.key || !KEY_RE.test(t.key)) out.push({ level: "error", path: p, msg: `Tool ${ti + 1} needs a key of letters, digits, _ or -` });
    else dupKey(t.key, p);
    if (!t.name.trim()) out.push({ level: "error", path: p, msg: `Tool ${ti + 1} needs a name` });
    if (!ALLOWED[modality].includes(t.type)) out.push({ level: "error", path: p, msg: `${t.type} tools do not apply to ${modality} projects` });
    if (!t.classes.length) out.push({ level: "warn", path: p, msg: `${t.name || "Tool"} has no classes` });
    const values = new Set<string>();
    const hotkeys = new Set<string>();
    t.classes.forEach((c, ci) => {
      const cp = `${p}.classes.${ci}`;
      if (!c.value.trim()) out.push({ level: "error", path: cp, msg: `${t.name}: class ${ci + 1} needs a value` });
      if (values.has(c.value)) out.push({ level: "error", path: cp, msg: `${t.name}: class value "${c.value}" repeats` });
      values.add(c.value);
      if (c.hotkey) {
        if (!/^[1-9]$/.test(c.hotkey)) out.push({ level: "error", path: cp, msg: `${t.name}: hotkey for ${c.name} must be 1-9` });
        if (hotkeys.has(c.hotkey)) out.push({ level: "error", path: cp, msg: `${t.name}: hotkey ${c.hotkey} repeats` });
        hotkeys.add(c.hotkey);
      }
      const col = c.color.toLowerCase();
      const owner = colorOwner.get(col);
      if (owner !== undefined && owner !== c.value)
        out.push({ level: "warn", path: cp, msg: `${t.name}: ${c.name} shares a colour with ${owner}` });
      if (owner === undefined) colorOwner.set(col, c.value);
      if (!/^#[0-9a-f]{6}$/i.test(c.color)) out.push({ level: "error", path: cp, msg: `${t.name}: ${c.name} colour must be #rrggbb` });
      else if (!PALETTE_LIGHT.includes(col)) {
        const cl = contrast(c.color, SURFACE_LIGHT);
        const cd = contrast(displayColor(c.color, "dark"), SURFACE_DARK);
        if (Math.min(cl, cd) < 2)
          out.push({ level: "warn", path: cp, msg: `${t.name}: ${c.name} is hard to see (${cl.toFixed(1)}:1 light, ${cd.toFixed(1)}:1 dark)` });
      }
    });
    if (t.classes.length > 9) out.push({ level: "warn", path: p, msg: `${t.name}: only the first 9 classes get number hotkeys` });
    (t.attributes ?? []).forEach((a, ai) => {
      if (!a.key || !KEY_RE.test(a.key)) out.push({ level: "error", path: `${p}.attributes.${ai}`, msg: `${t.name}: attribute ${ai + 1} needs a key` });
      if (a.type === "select" && !(a.options ?? []).length) out.push({ level: "warn", path: `${p}.attributes.${ai}`, msg: `${t.name}: ${a.key} has no options` });
    });
  });
  s.classifications.forEach((c, ci) => {
    const p = `classifications.${ci}`;
    if (!c.key || !KEY_RE.test(c.key)) out.push({ level: "error", path: p, msg: `Classification ${ci + 1} needs a key` });
    else dupKey(c.key, p);
    if (c.type !== "text" && !(c.options ?? []).length) out.push({ level: "warn", path: p, msg: `${c.name || c.key} has no options` });
  });
  return out;
}

export function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}
