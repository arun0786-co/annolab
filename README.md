# annolab

A data labeling platform for image, audio, video and text. Projects define their labels in a schema; annotators work through a queue in a keyboard-driven editor; several annotators can label the same item, and the platform measures how much they agree; reviewers approve or send work back with comments pinned to the exact spot; datasets export to COCO, YOLO or JSONL.

It runs locally with one command, ships with seeded demo data (heart sounds, photos and shape scenes, walking clips, clinical notes), and every test runs without a hand-started server.

![Labeling an image: boxes and an outline drawn on a generated shape scene](docs/images/label-image.png)

## Contents

- [Screens](#screens)
- [Features](#features)
- [Architecture](#architecture)
- [Run it](#run-it)
- [Measured numbers](#measured-numbers)
- [Compared with the course project it replaces](#compared-with-the-course-project-it-replaces)
- [Further reading](#further-reading)

## Screens

All screenshots are taken by `make screenshots` (Playwright, 1440x900) on freshly seeded data. Labels drawn in the editors follow each item's ground truth.

**Projects.** Every project with its modality, a progress bar split by item status, done share, mean agreement and annotators per item. `J`/`K` move, `Enter` opens, `L` starts labeling.

![Projects list](docs/images/projects.png)

**Project overview.** Status counts, per-annotator throughput (submitted, skipped, median and total time), label distribution, agreement per tool (F1, IoU, Cohen or Fleiss kappa), submissions per day and an activity feed.

![Project overview](docs/images/overview.png)

**Data rows.** Thumbnails for every modality (image, first video frame, audio waveform drawn in the browser, text snippet), status filters, search, annotator count per row, upload by button or drag and drop.

![Data rows](docs/images/data-rows.png)

**Schema editor.** Tools, classes (colour, value, hotkey), attributes and item-level classifications, validated as you type. The checks panel flags class colours that are hard to see in either theme, and the preview shows exactly what annotators will get.

![Schema editor](docs/images/schema-editor.png)

### Labeling editors

One editor shell serves all four modalities: tool rail on the left, canvas in the middle, classes, attributes, classifications and the annotation list on the right, save status, timer, undo/redo, skip and submit on top. Autosave runs 700 ms after the last change and before submit.

**Audio.** Waveform or spectrogram (both computed in the browser), zoom, playhead, drag to create a segment, playback speed. *Propose* asks the server's energy-based detector for S1/S2 candidates (dashed); `A` accepts one, `Shift+A` all of them, `N` and `Shift+N` step through segments, and new segments snap to proposal edges.

![Audio editor with model proposals](docs/images/label-audio.png)

![Spectrogram view](docs/images/label-audio-spectrogram.png)

**Video.** Frame scrubber and stepping, box tracks with keyframes and linear interpolation, time segments, and a timeline that shows each track's extent and keyframes.

![Video editor with a box track](docs/images/label-video.png)

**Text.** Select words to create a span. Overlapping spans stack as separate underlines (here a symptom span over a body site).

![Text editor with overlapping spans](docs/images/label-text.png)

**Sent back by a reviewer.** Rejected work returns to the annotator first, with the reviewer's note and numbered pins on the canvas. Clicking a pin attached to an annotation selects it.

![Annotator view of a rejected item](docs/images/label-feedback.png)

### Review

Each annotator's work is an overlay that can be toggled with `1`-`9`, drawn in that annotator's colour or, with one switch, in the class colours. The consensus diff lists matched pairs with their overlap, label conflicts and unmatched annotations, each with its location (time range, quoted text or box size and position); clicking a row selects that annotation and brings it into view. `C` pins a comment to a point, a time or an annotation; reject requires a comment.

![Reviewing an image](docs/images/review-image.png)

![Reviewing audio: two annotators' segments shaded on the plot, a pinned comment at 2.48 s](docs/images/review-audio.png)

![Reviewing text](docs/images/review-text.png)

### Export, shortcuts, dark theme

![Export dialog](docs/images/export.png)

![Keyboard shortcuts overlay](docs/images/shortcuts.png)

![Overview in the dark theme](docs/images/overview-dark.png)

![Audio editor in the dark theme](docs/images/label-audio-dark.png)

## Features

- **One annotation model for every modality.** An annotation is `(schema_key, label, geometry, attributes, source)`. Geometry is a box, polygon, point, time segment, box track with keyframes, or text span; classifications have no geometry. The schema decides which tools a project has, so adding a label type means editing the schema, not writing a new panel.
- **Labeling queue.** `GET /projects/{id}/queue/next` hands out the next item, respects annotators per item, never serves an item twice to the same person and never double-serves under concurrent requests (SQLite `BEGIN IMMEDIATE` plus a unique `(item, user)` index). Rejected work comes back first.
- **Keyboard first.** `1`-`9` classes, `B` box, `P` polygon, `O` point, `V` select, `H`/Space pan, `[` `]` step, Space play, `Mod+Z` undo, `Shift+Mod+Z` redo, `Enter` submit, `S` skip, `Del` delete, `?` lists everything.
- **Quality.** Agreement per item and per project: IoU matching for boxes and polygons, temporal IoU for segments, spatio-temporal IoU for tracks, overlap for spans, Cohen's kappa per annotator pair and Fleiss' kappa for classifications.
- **Review.** Approve or reject with comments pinned to an annotation, a point or a time. A reject reopens only the tasks of the annotators whose work was pinned.
- **Pre-labels.** Local, no network and no learned weights: a Shannon-energy heart-sound segmenter for audio and background subtraction with connected components for images.
- **Import and export.** Multi-file upload (a `.jsonl` text file becomes one item per line) or server folder import; COCO JSON, YOLO zip and JSONL export, by item status and by annotator (the one who agrees most with the others, or everyone).
- **Design.** One font stack, CSS variables for every colour and spacing step, one accent colour, light and dark themes that follow the system, focus rings, `aria-live` save status, empty, loading and error states on every view. Class colours default to a palette checked for contrast in both themes.

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser (React 18 + TypeScript, Vite)"]
    Pages["Pages: projects, overview,<br/>data rows, schema, review"]
    Shell["Labeler shell<br/>tool rail, side panel, top bar"]
    Editors["Modality canvases<br/>Image (SVG) / Audio (canvas + FFT)<br/>Video (video + SVG) / Text (DOM)"]
    Store["Annotation store<br/>undo/redo history"]
    Autosave["Autosave<br/>700 ms debounce, retry offline"]
    Client["api/client.ts<br/>the only module that calls the server"]
    Pages --> Client
    Shell --> Editors --> Store --> Autosave --> Client
  end

  subgraph Server["FastAPI (Python 3.12)"]
    Routers["Routers: auth, users, projects,<br/>items, workflow, exports"]
    Services["services.py<br/>queue, autosave replace, submit,<br/>skip, review, item status"]
    Schema["labelschema.py<br/>schema and annotation validation"]
    Consensus["consensus.py + geometry.py<br/>matching, IoU, kappa"]
    Prelabel["prelabel.py<br/>energy segmenter, image boxes"]
    Exporters["exporters.py<br/>COCO, YOLO, JSONL"]
    Media["media.py<br/>uploads, thumbnails, HTTP Range"]
    Routers --> Services --> Schema
    Routers --> Consensus
    Routers --> Prelabel
    Routers --> Exporters
    Routers --> Media
  end

  DB[("SQLite<br/>data/annolab.db")]
  Files[("data/media/")]
  Client -- "/api (JSON, bearer token)" --> Routers
  Services --> DB
  Consensus --> DB
  Media --> Files
```

| Part | Where |
|---|---|
| Data model | `backend/annolab/models.py`: User, Project, Item, Task, Annotation, Review, ReviewComment, AuditEvent |
| API contract | `backend/openapi.json` (27 paths under `/api`) |
| Editors | `web/src/pages/Labeler.tsx` (shell), `web/src/editors/*Editor.tsx` (canvases), `web/src/editors/store.ts` and `web/src/lib/history.ts` (undo) |
| Design tokens | `web/src/styles.css` |

## Run it

Needs Python 3.12 with [uv](https://docs.astral.sh/uv/), Node 20+, and ffmpeg (only for generating the demo videos).

```sh
make install       # uv sync + npm install
make seed          # wipe data/ and build the demo database and media (no downloads)
make dev           # API on 127.0.0.1:8000 and Vite on 127.0.0.1:5173 (proxies /api)
```

Open http://127.0.0.1:5173 and sign in with one of the demo accounts (dev only, password `annolab`): `admin@annolab.dev`, `annotator1@annolab.dev` to `annotator3@annolab.dev`, `reviewer1@annolab.dev`.

```sh
make test          # backend pytest, web vitest, tsc, Playwright e2e
make screenshots   # regenerate docs/images/*.png
make eval-prelabel # pre-label precision and recall on the seeded data
```

`make test` and `make screenshots` start their own throwaway stack (`scripts/with-stack.sh`): a freshly seeded data dir in a temp folder and the API and Vite on free ports. They never touch `data/` or a running `make dev`.

## Measured numbers

All from commands run on the development machine (Apple silicon laptop).

**Tests** (`make test`, exit 0, 58 s wall time in total):

| Suite | Result | Needs a server? |
|---|---|---|
| Backend pytest (`cd backend && uv run pytest`) | 145 passed in 19.16 s | No, in-process TestClient with a temp database per test |
| Web unit tests (`vitest run`) | 9 files, 61 tests passed | No |
| Typecheck (`tsc --noEmit`) | clean | No |
| Playwright e2e | 11 passed (33.6 s) | Starts its own via `with-stack.sh` |

The e2e specs cover: an admin creating a project, editing its schema, uploading files; an annotator labeling an image (box with a class) and an audio segment and submitting; a reviewer rejecting with a pinned comment; the annotator seeing that comment, moving the box and resubmitting; the reviewer approving; the admin downloading COCO and the test checking its contents; a crawl of every screen as each role that fails on any console error or failed API call; and keyboard checks that Tab moves focus out of every editor and that a missing project offers a link back.

**Pre-labels** (`make eval-prelabel`, matched at IoU >= 0.5):

| Data | Truth / proposals | Precision | Recall | Mean IoU of matches | Other |
|---|---|---|---|---|---|
| Heart sounds, 12 recordings (label must match) | 240 / 237 | 0.954 | 0.942 | 0.674 | median onset error 16.5 ms |
| Heart sounds, label ignored | 240 / 237 | 0.966 | 0.954 | | |
| Shape scenes, 10 images | 42 / 42 | 1.000 | 1.000 | 0.962 | |

The shape scenes have flat backgrounds, so the image detector is close to perfect there; on the photos it only gives rough boxes. The heart sounds are synthetic, with known onsets.

**Seeded agreement** (project list): heart sounds 0.66, objects and shapes 0.69, gait clips 0.79, clinical notes 0.86. Each is the mean, over items with two or more annotators, of the pairwise agreement scores of every tool and classification on the item: F1 for shapes, 1/0 for radio and Jaccard for checklist classifications. Per-tool F1 alone is lower for some projects, for example heart-sound segments 0.613 against the project figure 0.66 (`GET /projects/{id}/stats`).

**Other:**

- `make seed`: 1.2 s for 4 projects, 54 items, 101 tasks, 1,029 annotations and 15 reviews.
- Production build (`npm run build`): JS 317.79 kB (101.16 kB gzip), CSS 19.19 kB (4.35 kB gzip). Runtime dependencies: react, react-dom, react-router-dom.
- `make screenshots`: 3 tests passed in 26.7 s (32 s including stack start and PNG shrinking); 18 PNGs, the largest 394,563 bytes.

## Compared with the course project it replaces

annolab replaces a course team project for the same domain (clinical heart and lung sounds, images, video). No code was copied; only the domain carried over. Line counts are `git ls-files` + `wc -l` in each repository, excluding lock files, build configs and media; tests are counted separately.

| | Course project | annolab |
|---|---|---|
| Backend source | 6,552 lines of Python (FastAPI + MongoDB) | 3,995 lines of Python (FastAPI + SQLite) |
| Frontend source | 21,675 lines of JS/JSX + 2,621 CSS | 7,293 lines of TS/TSX + 1,327 CSS |
| Backend tests | 376 test functions in 14 files plus `conftest.py` (3,909 lines), run through httpx against a live server (`API_URL`, default `http://localhost:8000`), so a running server and database are required | 145 tests (1,577 lines), in-process with a temp database |
| Frontend tests | none | 61 unit tests and 11 Playwright e2e tests, both started by `make test` |
| Editor architecture | a separate workspace component per modality (`SoundAnnotatorWorkspace`, `ImageAnnotatorWorkspace`, `VideoAnnotatorWorkspace`, `TextAnnotatorWorkspace`) plus hand-written panels per label type (heart, respiratory, blood pressure) | one labeler shell and one annotation model; tools, classes and attributes come from the project schema |
| Agreement and review | reviewer workspace with approve/reject; its "Inter-Annotator Agreement" chart shows fixed placeholder values (85/15), nothing is computed | IoU and temporal IoU matching, Cohen and Fleiss kappa, consensus diff per item, comments pinned to annotations |
| Export | CSV and JSON per dataset (heart, respiratory and blood-pressure fields), audit log as CSV | COCO, YOLO (zip), JSONL for every modality |

## Further reading

- [docs/report.md](docs/report.md): the full write-up: problem, design decisions, data model, agreement math, queue logic, pre-label method and accuracy, evaluation, limitations.
- [docs/how-it-works.md](docs/how-it-works.md): teaching notes that walk through the main request flows and the editor architecture.
- [backend/README.md](backend/README.md) and [web/README.md](web/README.md): per-package notes.
- [docs/data-licenses.md](docs/data-licenses.md): licenses of the bundled sample images.
