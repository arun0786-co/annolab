# Demo data and licenses

`make seed` builds every file in `data/` on the local machine. Nothing is downloaded at seed or run time, and nothing in `data/` is committed.

## Generated data (no third-party content)

| Project | Files | How they are made | Ground truth kept in `item.meta.truth` |
|---|---|---|---|
| Heart sound segmentation | 12 WAV, 4 kHz, 16-bit, 8 s | `annolab.synth.phonocardiogram`: windowed low-frequency bursts for S1 and S2 at 58-96 bpm with beat-to-beat jitter, a band-limited (180-450 Hz) systolic murmur on every fourth recording, white noise at 10-30 dB SNR and slow baseline wander | S1/S2 start and end times, heart rate, murmur flag, SNR |
| Objects and shapes (synthetic part) | 10 PNG, 640x480 | `annolab.synth.shape_scene`: non-overlapping circles, rectangles and triangles on a flat background, drawn with `skimage.draw` | class, box and polygon of every shape |
| Gait clips | 6 MP4, 320x240, 15 fps, 6 s | `annolab.synth.gait_frames` renders a walking figure (body box plus two feet) with numpy; ffmpeg encodes it with libx264. Every third clip has a shorter right-foot swing ("limping") | keyframed boxes for walker and both feet, gait label |
| Clinical notes NER | 20 TXT | `annolab.synth.clinical_note` fills sentence templates with symptom, medication, dosage and body-site terms. The notes are fictional and describe no real patient | character spans per entity, urgency |

The annotations from `annotator1..3` and the reviews are simulated from that ground truth with per-annotator noise (boundary jitter, missed objects, wrong classes, spurious objects) so that agreement scores and review history have something real to show. See `backend/annolab/seed.py`.

## Third-party images

Six photos come from the sample data that ships inside the scikit-image wheel (`skimage/data/`, version 0.26.0 was used). They are read from the installed package, not fetched. The license notes below are quoted from each loader's docstring in that version (`python -c "import skimage.data as d; help(d.astronaut)"`).

| File in the demo | Loader | Source and license note (as stated by scikit-image) |
|---|---|---|
| `astronaut.jpg` | `skimage.data.astronaut()` | Eileen Collins, from the NASA Great Images database. "No known copyright restrictions, released into the public domain." |
| `camera.png` | `skimage.data.camera()` | "No copyright restrictions. CC0 by the photographer (Lav Varshney)." |
| `chelsea.jpg` | `skimage.data.chelsea()` | Chelsea the cat. "No copyright restrictions. CC0 by the photographer (Stefan van der Walt)." |
| `coffee.jpg` | `skimage.data.coffee()` | Coffee cup, courtesy of Pikolo Espresso Bar. "No copyright restrictions. CC0 by the photographer (Rachel Michetti)." |
| `coins.png` | `skimage.data.coins()` | Greek coins from Pompeii, Brooklyn Museum Collection. "No known copyright restrictions." |
| `rocket.jpg` | `skimage.data.rocket()` | Launch of DSCOVR on Falcon 9, captured by SpaceX and "released in the public domain". |

The object boxes for these six photos were drawn by hand for this project (`PHOTO_TRUTH` in `seed.py`); for `coins.png` they were taken from a thresholded connected-component pass and checked visually.

Other images bundled with scikit-image were left out: some have no license note in their docstring (for example `moon`, `page`), and others did not fit the demo's classes.

## Software used to make the data

- numpy and scikit-image (BSD-3-Clause) for signals, shapes and drawing.
- Pillow (MIT-CMU license) for image files and thumbnails.
- ffmpeg with libx264 for encoding the gait clips. The encoder is run locally; no ffmpeg code is redistributed.
