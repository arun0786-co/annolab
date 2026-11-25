# annolab backend

FastAPI + SQLAlchemy 2 + SQLite. One annotation table and one schema format serve image, audio, video and text projects.

```sh
make seed          # wipe data/ and build the demo (users, 4 projects, media)
make backend-dev   # API on 127.0.0.1:8000, docs at /api/docs
make backend-test  # pytest, in-process, temp database per test
make openapi       # rewrite backend/openapi.json
make eval-prelabel # pre-label precision/recall on the seeded data
make backend-smoke # start the server, curl the main endpoints, stop it
```

Demo logins (dev only): `admin@annolab.dev`, `annotator1@annolab.dev` .. `annotator3@annolab.dev`, `reviewer1@annolab.dev`, password `annolab`.

Settings come from the environment: `ANNOLAB_DATA_DIR` (default `../data`), `ANNOLAB_SECRET` (default: a random secret stored in `data/.secret`).

## Layout

| Module | What it does |
|---|---|
| `models.py` | User, Project, Item, Task, Annotation, Review, ReviewComment, AuditEvent |
| `labelschema.py` | validates a project schema per modality and every annotation against it |
| `services.py` | queue, autosave replace, submit, skip, review; item status is derived from tasks and the latest review |
| `geometry.py`, `consensus.py` | IoU for boxes and polygons, temporal IoU for segments, spatio-temporal IoU for tracks, span overlap, greedy matching, Cohen and Fleiss kappa |
| `prelabel.py` | Shannon-energy heart-sound segmentation, background-difference image boxes |
| `exporters.py` | COCO JSON, YOLO zip, JSONL |
| `media.py` | uploads, metadata (Pillow, wave, ffprobe), thumbnails, HTTP Range |
| `synth.py`, `seed.py` | generated demo data with known ground truth |

## Design notes

**Queue.** `GET /projects/{id}/queue/next` first returns the caller's open task in the project (rejected items first). Otherwise it picks an item that is unlabeled or in progress, that the caller has never had a task for (including skipped ones), and whose count of assigned + in-progress + submitted tasks is below `annotators_per_item`. Items that others already started come first, then oldest. SQLite runs every transaction as `BEGIN IMMEDIATE`, so the capacity check and the insert cannot interleave across requests; a unique `(item_id, user_id)` index is the second guard. An assigned task that was never saved gives its slot back after 2 hours.

**Autosave.** `PUT /tasks/{id}/annotations` replaces the whole set. Entries that send an existing `id` keep it, so review comments stay pinned across saves; entries not sent are deleted. The request is validated in full before anything is written. `time_spent_ms` is cumulative and only grows.

**Review.** Reject reopens the tasks of the annotators whose annotations carry pinned comments (or `reopen_user_ids`, or everyone). They get the item back from the queue with the review attached; resubmitting sends it to review again.

**Consensus.** Two annotators' annotations for a tool are matched greedily by similarity, highest first, at a threshold (0.5 by default, `?threshold=` to change). Pair agreement is `2 * same-label matches / (|A| + |B|)`. Tracks use mean box IoU over the union of their time extents, sampled every 0.1 s. Classifications score 1/0 per pair (Jaccard for checklists); across items they get Cohen's kappa per annotator pair and Fleiss' kappa. The tests check these against hand-worked values, including the 10-item Fleiss example (kappa 0.210).

**Media.** `<audio>`, `<video>` and `<img>` cannot send headers, so the media and thumbnail endpoints also accept `?token=`. Range requests return 206 with `Content-Range`; suffix ranges (`bytes=-N`) and open ranges work; bad ranges return 416.

**Ground truth.** Seeded items keep their synthetic truth in `meta.truth`. Only admins see it through the API.

## Measured on this machine

Commands and output from the last run:

- `make test` (backend part): `145 passed in 19.16s`
- `make seed`: `seeded .../data in 1.2 s`
  - Heart sound segmentation (audio): 12 items (approved 5, in_progress 3, in_review 3, rejected 1); 21 tasks, 426 annotations, 6 reviews
  - Objects and shapes (image): 16 items (approved 3, in_progress 2, labeled 8, rejected 1, unlabeled 2); 39 tasks, 335 annotations, 4 reviews
  - Gait clips (video): 6 items (approved 2, in_progress 1, in_review 2, unlabeled 1); 9 tasks, 44 annotations, 2 reviews
  - Clinical notes NER (text): 20 items (approved 3, in_progress 4, labeled 11, unlabeled 2); 32 tasks, 224 annotations, 3 reviews
- `make eval-prelabel`:
  - heart sounds, segment IoU >= 0.5: 240 true segments, 237 proposals; with labels precision 0.954, recall 0.942; mean IoU of matches 0.674; median onset error 16.5 ms
  - synthetic shape scenes, box IoU >= 0.5: 42 objects, 42 proposals; precision 1.000, recall 1.000; mean IoU 0.962
- Agreement on the seeded annotations (`GET /projects/{id}/stats`): heart-sound segments F1 0.613; image boxes F1 0.766; text entities F1 0.790; urgency Fleiss kappa 0.850.

The shape scenes have flat backgrounds, so the image pre-labeller is close to perfect there; on the photos it only gives rough boxes.
