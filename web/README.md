# annolab web

React 18 + TypeScript + Vite front end for annolab. No UI library: one stylesheet of design tokens (`src/styles.css`), SVG and canvas for every editor, and one typed API module (`src/api/client.ts`).

## Run

```sh
npm install
npm run dev          # Vite on 127.0.0.1:5173, proxies /api to 127.0.0.1:8000
npm test             # vitest: geometry, tracks, undo stack, spans, palette, dsp, matching, schema checks
npm run typecheck    # tsc --noEmit over src, e2e and configs
npm run e2e          # Playwright against a running, seeded stack (make seed && make dev)
npm run screenshots  # README screenshots into ../docs/images (PNG, each kept under 400 KB)
```

`ANNOLAB_API` changes the proxy target and `WEB_PORT` the dev port. Playwright reads `WEB_URL` (default `http://127.0.0.1:5173`) and the screenshot spec reads `SHOTS_DIR`.

## Layout

```
src/
  api/          types.ts (wire types, aligned with backend/openapi.json), client.ts (every request)
  lib/          pure logic with unit tests: geometry, track, history, spans, palette, dsp, match, schema, format
  hooks/        useAsync, useHotkeys, useAutosave, useMedia, useElementSize
  components/   app shell, dialog, shortcuts overlay, empty/loading/error states, SVG charts, export dialog
  editors/      ImageEditor, AudioEditor, VideoEditor, TextEditor, shared panels, annotation store
  pages/        Login, Projects, ProjectLayout, Overview, DataRows, SchemaEditor, Labeler, Review
e2e/            flow.spec.ts (label, submit, approve), screenshots.spec.ts
```

## How the editors share one shell

Every modality edits the same list of annotations (`schema_key`, `label`, `geometry`, `attributes`, `source`). The labeling page owns that list through `useAnnStore`, which wraps the pure undo stack in `lib/history.ts`. Editors never set state directly: they call `edit.add`, `edit.patch` and `edit.remove`. A drag opens a transaction with `edit.begin()` and closes it with `edit.commit()`, so a whole move or resize is one undo step however many pointer events it took.

The rail, class picker, attribute panel, item classifications and annotation list come from the project schema, not from per-modality code. Tool types map to editors: `bbox`, `polygon`, `point` to the image canvas; `segment` to audio and to video time ranges; `track` to video boxes; `span` to text.

The review page renders the same editors read-only, with each annotator's set as a coloured overlay that can be toggled (keys 1-9), the server's consensus matching as a diff list, and comments pinned to a point, a time or an annotation.

## Autosave

`useAutosave` debounces the full annotation set (700 ms) into `PUT /api/tasks/{id}/annotations`. The status chip in the top bar is an `aria-live` region showing Saved, Unsaved, Saving, Offline or Save failed. Failed saves retry every 4 s and on the browser's `online` event. Submit and Skip flush first, and leaving an item sends anything still pending.

## Colour

Class colours default to an eight-slot categorical palette (`lib/palette.ts`) with a separate step per theme. The order was checked for colour-vision-deficiency separation on adjacent slots in both themes; `palette.test.ts` records each slot's contrast against both surfaces. Four light-mode slots sit under 3:1 on white, so class names are always drawn as text next to the colour (on-canvas tags, class list, legends). Chip text picks black or white per colour and reaches 4.5:1 on every slot. The schema editor warns about custom colours under 2:1 in either theme.

## Keyboard

Press `?` anywhere for the full list. The common ones: `1`-`9` class, `V` select, `B` box or track, `P` polygon, `O` point, `R` segment, `Space` play or pause, `[` `]` step a frame or 0.1 s, `Cmd/Ctrl+Z` undo, `Shift+Cmd/Ctrl+Z` redo, `Enter` submit, `S` skip, `Del` delete.
