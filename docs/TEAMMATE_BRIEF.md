# Brief for the training teammate

## What you are doing (read this first)

SAMAAN finds accessibility barriers on Indian footpaths from street photos and routes wheelchair
users around them. Every part of the system is built and runs on seeded demo data. The one piece
missing is the real detector: a YOLO model trained on photos of our zone around Karkarduma
metro. Your job is to produce that model and its honest evaluation numbers on a GPU machine.

That means three things, in order. First, labelled images must exist: photos from our walks,
boxed and classed in Roboflow or CVAT following `docs/labelling_guide.md` (eight classes such
as steps, open drain, parked vehicle). Second, train the model with the project's own scripts,
which split the data by street so the test street is never seen in training. Third, run the
evaluation script, which writes per-class precision and recall into `eval/results/`; those files
are the numbers we will say on stage, so they must come from the script, never typed by hand.
Send back the weights file and commit the results. Everything you need is in
`docs/gpu_training_handoff.md`. If something blocks you, write it in `docs/PROGRESS.md` under
Human tasks rather than guessing.

## Prompt to paste into your Claude session

```text
You are helping with SAMAAN, a hackathon project (problem SC-02: accessible walking routes from
street imagery, Karkarduma metro, East Delhi). Repo: https://github.com/gautampartha/SAMAAN
(clone it, branch `main`). My job on this machine is ONLY the detector: make labelled data
usable, train YOLO on the GPU, evaluate on the held-out street, and hand the weights and result
files back. The rest of the system is already built and must not be changed.

Read these before doing anything, in this order:
1. docs/gpu_training_handoff.md (prerequisites, exact commands, what to bring back)
2. docs/labelling_guide.md (classes, severity, export/import steps)
3. docs/PROGRESS.md: the "Human tasks" numbered 11, 12 and 13, and the P3 section
4. config/taxonomy.yaml and config/train.yaml
5. SAMAAN_PLAN.md section 6.3 and section 11 (rules)

Hard rules (from SAMAAN_PLAN.md section 11):
- Never fabricate or hand-edit any number. Evaluation files in eval/results/ are written only
  by ml/eval.py and ml/domain_gap.py. If data is missing, say so; do not invent results.
- Synthetic data never enters eval/results/ (the scripts refuse it; do not work around that).
- Do not change the architecture, configs or code outside ml/ and config/train.yaml (only
  epochs, batch, imgsz, device, model may change there). Ask me before adding a dependency.
- Do not commit images, the dataset images folder, weights (*.pt), or ml/runs/; they are
  gitignored on purpose. Commit label txt files, manifest.csv, splits.json, data.yaml and the
  eval/results/ files.
- Work on a branch named train-v1 and push it; do not push to main.

Steps:
1. Environment: follow the handoff doc. Python 3.11 + uv, `uv pip install -e ".[dev]"`, then
   install the CUDA PyTorch build (or MPS on Apple Silicon) and confirm
   `python -c "import torch; print(torch.cuda.is_available())"` prints True. Report the GPU name.
2. Dataset: I will give you the YOLO export zip from Roboflow/CVAT (or the folder
   data/labels/karkarduma_v1 with images). Run
   `python -m ml.dataset import <export_dir> --name karkarduma_v1`, read the printed summary
   (images, boxes, boxes dropped for unknown class, boxes per street). If more than a handful
   of boxes were dropped or any street is "unknown", stop and show me before continuing.
3. Split: `python -m ml.dataset split --name karkarduma_v1`. Show me data/labels/karkarduma_v1/
   splits.json. The test split must be exactly one whole street with a sensible share of boxes;
   if the auto-pick is bad, rerun with `--test-street <name>` after asking me.
4. Train: `make train NAME=karkarduma_v1` (or the python -m ml.train equivalent on Windows).
   Use config/train.yaml defaults first (yolo11n, 60 epochs, 640 px). If the GPU has 8 GB or
   more and time allows, do a second run with model yolo11s.pt and run-name karkarduma_v1_s.
   Keep the terminal output; report final epoch count, training time and best epoch.
5. Evaluate: `make eval NAME=karkarduma_v1 WEIGHTS=ml/runs/karkarduma_v1/weights/best.pt`
   (and the _s run with its own --tag if trained). Paste the per-class table it prints. Do not
   edit the generated files.
6. Domain gap (only if config/domain_gap.yaml has baseline weights filled in; otherwise skip
   and say so): `python -m ml.domain_gap --name karkarduma_v1 --ours ml/runs/karkarduma_v1/weights/best.pt`.
7. Hand back: commit the label files, manifest, splits, data.yaml and everything new in
   eval/results/ on branch train-v1 and push. Separately send me ml/runs/karkarduma_v1/weights/
   best.pt (and samaan_train_meta.json) via drive, since weights are gitignored.
8. Write a short section at the end of docs/PROGRESS.md titled "Training run (teammate)" with:
   GPU used, dataset counts, test street, epochs, training time, the eval table, and any
   problems. Include it in the same commit.

When you finish, give me: the branch name, the commit hash, the eval table, where best.pt is,
and anything you had to skip and why.
```
