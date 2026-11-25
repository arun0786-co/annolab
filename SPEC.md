# annolab spec

A multimodal data labeling platform (image, audio, video, text) with label schemas, a labeling queue, review, consensus and quality metrics, and dataset export. It replaces a course team project (FastAPI + Mongo + React, ~29k lines, separate hand-written workspace per modality, live-server-only tests). Nothing is copied from that repo; we only reuse the domain: clinical heart and lung sounds, oral-cavity images, video clips.

What makes this one better:
1. One generic annotation model and one schema system for every modality, instead of a hard-coded panel per label type.
2. Real labeling ergonomics: keyboard-first, undo/redo, zoom/pan, hotkeys per class, autosave, queue that serves the next item.
3. Quality built in: multiple annotators per item, consensus with measured agreement (IoU for boxes, temporal IoU for audio/video segments, Cohen/Fleiss kappa for classifications), reviewer approve/reject with comments pinned to an annotation.
4. Model-assisted pre-labels (simple, local, no network): e.g. energy-based onset detection to propose heart-sound segments; optional image proposals.
5. Export to COCO, YOLO, and JSONL; import via upload or folder.
6. Tests that run in-process (no live server), seeded demo data, one command to run.

## Stack

- `backend/`: Python 3.12, FastAPI, SQLAlchemy 2 + SQLite (file `data/annolab.db`), Pydantic v2, JWT auth (python-jose or pyjwt), passlib/bcrypt or hashlib.scrypt. Media stored under `data/media/`. pytest with httpx TestClient. Managed with `uv` (`backend/pyproject.toml`).
- `web/`: React 18 + TypeScript + Vite. Plain CSS modules or a single CSS file with design tokens (no Tailwind, no component library). Canvas/SVG for image and video tools, Web Audio + canvas for waveform and spectrogram. react-router. Vitest for unit tests, Playwright for e2e and screenshots.
- Dev: backend on 127.0.0.1:8000, Vite on 127.0.0.1:5173 proxying `/api` to the backend. `make dev`, `make test`, `make seed`, `make screenshots`.

## Domain model

- User: id, email, name, role in {admin, annotator, reviewer}, password hash.
- Project: id, name, description, modality in {image, audio, video, text}, schema (JSON, see below), annotators_per_item (int, default 1), review_required (bool), instructions (markdown), created_at.
- Item: id, project_id, kind, filename, media_path, meta (JSON: width/height, duration, fps, sample_rate, text), status in {unlabeled, in_progress, labeled, in_review, approved, rejected}, created_at.
- Task: id, item_id, user_id, status in {assigned, in_progress, submitted, skipped}, started_at, submitted_at, time_spent_ms. One task per (item, annotator).
- Annotation: id, task_id, item_id, user_id, schema_key (which tool/class group), label (class value), geometry (JSON, by type below), attributes (JSON), source in {human, model}, created_at, updated_at.
- Review: id, item_id, reviewer_id, decision in {approve, reject}, comment, created_at. ReviewComment: id, review_id, annotation_id nullable, body, x/y or t (anchor).
- AuditEvent: id, user_id, action, entity, entity_id, payload, at.

Geometry by type:
- bbox: {x, y, w, h} in source pixels.
- polygon: {points: [[x,y],...]}.
- point: {x, y}.
- segment (audio/video time range): {start, end} seconds.
- track (video box over time): {keyframes: [{t, x, y, w, h}]}, linear interpolation between keyframes.
- span (text): {start, end} character offsets.
- classification: no geometry, just label (+ attributes).

Schema (project.schema) example:
```json
{
  "tools": [
    {"key": "heart", "type": "segment", "name": "Heart sounds", "classes": [
      {"value": "S1", "name": "S1", "color": "#d1495b", "hotkey": "1"},
      {"value": "S2", "name": "S2", "color": "#2e86ab", "hotkey": "2"}
    ], "attributes": [{"key": "confidence", "type": "select", "options": ["low","medium","high"]}]}
  ],
  "classifications": [
    {"key": "quality", "name": "Recording quality", "type": "radio", "options": ["good","noisy","unusable"]}
  ]
}
```

## API (all under /api, JSON, bearer token)

- POST /auth/login {email,password} -> {token, user}; GET /auth/me
- GET/POST /users (admin); PATCH /users/{id}
- GET/POST /projects; GET/PATCH/DELETE /projects/{id}
- GET /projects/{id}/stats -> counts by item status, per-annotator throughput (items, median seconds/item), agreement summary, label distribution
- POST /projects/{id}/items (multipart upload, many files) ; GET /projects/{id}/items?status=&q=&page=
- GET /items/{id} ; GET /items/{id}/media (file stream, supports Range for audio/video)
- GET /projects/{id}/queue/next -> next Task for current user (creates it; respects annotators_per_item; never serves an item the user already did) or 204
- GET /tasks/{id} ; POST /tasks/{id}/submit ; POST /tasks/{id}/skip
- GET /items/{id}/annotations?user_id= ; PUT /tasks/{id}/annotations (replace full set for the task, used by autosave) 
- POST /items/{id}/prelabel -> model proposals (source=model) for audio segments / images
- GET /projects/{id}/review/queue/next ; POST /items/{id}/reviews {decision, comment, comments:[...]}
- GET /items/{id}/consensus -> per-annotator sets, matched pairs, agreement score
- GET /projects/{id}/export?format=coco|yolo|jsonl (zip for yolo)
- GET /projects/{id}/activity (audit feed)

Errors: {detail} with correct status codes. Pagination: {items, total, page, page_size}.

## Seed data (`make seed`), all generated or permissively licensed, no network needed at run time

- Users: admin@annolab.dev / annotator1..3 / reviewer1, password `annolab` (dev only, documented).
- "Heart sound segmentation" (audio): ~12 synthetic phonocardiogram WAVs generated with numpy (S1/S2 bursts at a realistic heart rate, some with a murmur band and noise). Ground truth known, so pre-label accuracy can be measured.
- "Oral cavity screening" or general "Street objects" (image): use scikit-image `data` sample images (public domain/CC0; check each license in skimage docs) plus generated images; bbox/polygon/classification schema.
- "Gait clips" (video): short synthetic mp4s via ffmpeg (moving shapes), track tool.
- "Clinical notes NER" (text): ~20 short synthetic notes, span tool with classes like symptom, medication, dosage.
- Pre-populate some submitted annotations from 2-3 annotators with realistic disagreement, and some reviews, so dashboards and consensus have real numbers to show.

## UI and design principles

Original UI. Do not copy any product's branding, logo, name or exact layout. Conventions common to labeling tools are fine (left tool rail, center canvas, right panel with classes and annotation list, top bar with item nav and submit).

- One sans-serif font stack (system UI / Inter if available offline; no CDN), 4 px spacing scale, 8 px radius max, 1 px borders, no gradients, no shadows beyond one subtle elevation, no emoji.
- Neutral grays plus one accent color (e.g. blue #2563eb). Class colors come from the schema; use a validated categorical palette of 8 distinguishable colors for defaults.
- Light and dark themes via CSS variables; respect prefers-color-scheme.
- Information density like a pro tool: compact tables, 13-14 px body, tabular numbers for stats.
- Every action reachable by keyboard; a `?` overlay lists shortcuts. Visible focus rings. Hotkeys: 1-9 classes, B box, P polygon, V select, Space play/pause, [ ] prev/next frame or 0.1 s, Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z redo, Enter submit, S skip, Del delete.
- Empty, loading and error states for every view. Optimistic UI with autosave indicator ("Saved", "Saving", "Offline").
- Accessible: semantic HTML, labels on inputs, contrast AA, aria-live for save status.

Screens:
1. Login.
2. Projects list (cards or table with modality, progress bar, items, agreement).
3. Project overview: progress by status, throughput per annotator, label distribution chart, agreement, recent activity.
4. Data rows table: thumbnails/waveform mini, status filters, search, per-row annotator count.
5. Labeling editor per modality, same shell:
   - image: zoom/pan, bbox, polygon, point, class picker, attribute panel, annotation list with hide/lock.
   - audio: waveform + spectrogram toggle, zoom, play head, drag to create segments, snap to model proposals, playback speed.
   - video: frame scrubber, play, box tracks with keyframes and interpolation, timeline showing track extents.
   - text: select to create spans, overlapping spans shown as stacked underlines.
6. Review view: annotation overlay per annotator (toggle), consensus diff, approve/reject with pinned comments.
7. Schema editor in project settings (add tools/classes/colors/hotkeys/attributes) with live preview.
8. Export dialog.

## Quality bar

- Backend: pytest suite for auth, permissions per role, queue fairness and no double serving under concurrency, annotations replace/autosave, review flow, consensus math (unit tests with hand-computed IoU/kappa), export formats (COCO validated by loading with pycocotools if available or schema checks), prelabel accuracy on synthetic ground truth.
- Web: typecheck clean (`tsc --noEmit`), vitest for geometry utils (interpolation, hit testing, undo stack), Playwright e2e for login -> label image -> submit -> review approve.
- README with real screenshots (Playwright, committed under docs/images, PNG, each < 400 KB), architecture diagram, measured numbers only.
- docs/how-it-works.md teaching notes: design decisions, consensus math, queue logic.
- Commits: many small, short lowercase messages (e.g. "add queue endpoint"), no trailers, no mention of AI tools anywhere.
