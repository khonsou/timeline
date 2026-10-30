# Timeline bootstrap

These NAS PersistentVolumes and PersistentVolumeClaims are applied once and are
deliberately outside Argo CD:

- `timeline-board-nas` → `angrymiao-prod/timeline-board-data`
- `timeline-board-test-nas` → `angrymiao-test/timeline-board-test-data`

They are already bound in the live cluster. Do **not** apply these files during a
normal release. Use them only when rebuilding the environment, and keep the PV
`Retain` policy.

The backend Deployment references these PVCs; the Application only manages the
Deployments, Services, and Ingress.