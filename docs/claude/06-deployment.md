> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Deployment

## Deployment

Merging to `main` does **not** deploy: this repository has no CI/CD deployment
step. Production is the Debian host **QuietlyConfident** (`192.168.86.36`),
reachable with `ssh clavain@192.168.86.36` and serving the dashboard on port
`3001`. Its checkout is
`/home/clavain/energy-dashboard/repos/energy-dashboard-frontend`.

After the reviewed commit is pushed to GitHub, deploy from that host:

```bash
cd /home/clavain/energy-dashboard/repos/energy-dashboard-frontend
git pull
cd docker
docker compose build
docker compose up -d --force-recreate
```

Do not commit code on production. The client and server are built into one image,
so this deploy updates them together. Do not infer deployed state from git
ancestry or an issue marked done: ABL-120 found merged work still undeployed.
Inspect the running container and the served bundle instead. The fuller runbook
is [`../WORKFLOWS.md`](../WORKFLOWS.md), which is intentionally outside this
repository.
