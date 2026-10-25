# SAMAAN Authority Console

The web app for the people who fix footpaths: the campus estate office, a municipal ward office or
a contractor. Citizens report barriers from the SAMAAN phone app; the console turns them into
repair jobs and closes the loop.

## Open it
- Laptop / demo: `make api` (or `make api-lan`), then `make admin-build` once, and open
  `http://127.0.0.1:8000/admin`. During development: `make web` and open
  `http://127.0.0.1:5173/admin.html` (talks to the API on port 8000).
- Cloud VM: `https://<host>/admin` (built and uploaded by `make deploy`, see DEPLOY.md).
- English / हिन्दी toggle in the top bar.

## Sections
| Section | What it does |
|---|---|
| Overview | Reports to review, active barriers (real vs seed), barriers without a job, jobs in progress / overdue, fixed in 7 days, median job turnaround, map (red = needs a job, amber = job open, green = fixed; hollow = seed data), "Needs action" list with Assign |
| Reports | Citizen reports with photo, reporter trust, community votes, detector agreement; **Verify** (creates or updates the barrier, or marks it fixed for a "fixed" report) or **Reject**, with a note for the record. Overrides the community vote. |
| Barriers | Every barrier with severity, first seen, number of reports, real/seed, current job; **Assign worker** |
| Work orders | Board Open → Assigned → In progress; reassign, Start work, **Mark fixed** (with what was done), Can't fix, Cancel; full history per job; recently closed |
| Workers | Add field staff (name, phone, department, area), see open jobs, deactivate |

**Mark fixed** sets the barrier to fixed, recomputes footpath states and reloads routing, so the
citizen app stops routing around it immediately.

## API (all under /admin)
`GET summary`, `GET reports?status=`, `POST reports/{id}/decision {decision: verify|reject, note}`,
`GET barriers?status=active|fixed|all`, `GET/POST workers`, `PATCH workers/{id}`,
`GET workorders?status=open_all|all|<status>`, `POST workorders {barrier_id, worker_id?, priority,
due_date?, note?, created_by?}`, `PATCH workorders/{id} {status?, worker_id?, priority?, due_date?,
note?, resolution_note?, by?}`. Job states: open → assigned → in_progress → done | cant_fix |
cancelled (done and cancelled are final; one open job per barrier).

## Access
Set `SAMAAN_ADMIN_TOKEN` in the API's environment before the console is reachable from the
internet (a tunnel or the VM). Without it the console is open and shows a warning banner. Staff
enter the token once per browser; it is sent as `X-Admin-Token`.

## Honest numbers
"Median time to close a job" counts from job creation to "Mark fixed" and stays empty until a job
is closed. Barrier "first seen" is the capture time of the earliest photo that showed it, which for
Mapillary imagery can be years ago.
