# Infrastructure (Terraform)

Everything for the Mumbai (`asia-south1`) deployment of project `codecell-vesit`: APIs, service accounts, Artifact Registry,
Secret Manager containers, Cloud Run services and jobs, Cloud Scheduler, Workload Identity Federation for GitHub Actions,
the resume bucket binding, alerts, uptime check and an optional budget. Repository: `Harshavardhan-28/Mail-autosender-service`.

**Ownership (GitOps).** Terraform owns the Cloud Run service *shell* (name, ingress, service account, public invoker IAM) and
everything around it. The deploy workflow owns the services' images, traffic and the whole runtime config: env vars come from
`deploy/backend.env.yaml` and `deploy/web.env.yaml`, secret references, resources, probes, timeout, concurrency, scaling and
port from `.github/workflows/deploy.yml`. Both services therefore carry
`ignore_changes = [template, traffic, client, client_version]`, which stops Terraform and CI colliding on revisions (the old
`409 Revision ... with different configuration already exists`). The `template` in `cloud_run.tf` is a bootstrap used only by
the first apply (placeholder image). There are no Terraform variables for env vars (no `dry_run`, `trust_proxy_hops`,
`daily_send_cap`, ...): to change `DRY_RUN` edit `deploy/backend.env.yaml` in a PR. Jobs `mail-migrate` / `mail-seed-admin`
keep their config in Terraform (CI only swaps their image). Secret values never enter Terraform or its state.

| File | What |
| --- | --- |
| `versions.tf` | Terraform and provider pins, GCS backend (`codecell-vesit-tfstate`, prefix `mail-autosender/infra`) |
| `apis.tf` | Enabled APIs |
| `iam.tf` | Service accounts and least-privilege roles (backend, web, migrate, scheduler-invoker, github-deployer, github-planner) |
| `secrets.tf` | Secret containers, accessor bindings, optional placeholder version 1 |
| `cloud_run.tf` | Service shells `mail-backend` and `mail-web` (template ignored), jobs `mail-migrate` and `mail-seed-admin` |
| `scheduler.tf` | `send-window` and five `reply-sweep-*` jobs (Asia/Kolkata, OIDC) |
| `wif.tf` | Workload Identity pool, two providers, impersonation bindings |
| `bucket.tf` | Existing resume bucket (import) and the backend's `objectUser` binding |
| `monitoring.tf` | Alert policies, log metric, uptime check, optional budget |
| `../deploy/` | Not Terraform: runtime env files applied by the deploy workflow, and `check-config.sh` (CI lint) |

## Bootstrap (one time, from a workstation)

Prerequisites: `gcloud` logged in as an owner of the project (`gcloud auth login` and
`gcloud auth application-default login`), Terraform >= 1.9. Nothing here is run by CI.

1. **Minimum APIs** (Terraform enables the rest, but needs these to talk to the API at all):

   ```sh
   gcloud config set project codecell-vesit
   gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
     iam.googleapis.com storage.googleapis.com cloudbilling.googleapis.com
   ```

2. **State bucket** (versioned, private, same region; created by hand, not by Terraform):

   ```sh
   gcloud storage buckets create gs://codecell-vesit-tfstate \
     --project=codecell-vesit --location=asia-south1 \
     --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update gs://codecell-vesit-tfstate --versioning
   ```

3. **Variables**:

   ```sh
   cd infra
   cp terraform.tfvars.example terraform.tfvars   # set alert_email, github_repository_id (gh api repos/OWNER/NAME --jq .id) and, only if you can create budgets, billing_account_id
   terraform init
   ```

4. **Import the existing resume bucket** (it holds real data; do not let Terraform create it):

   ```sh
   terraform import google_storage_bucket.resumes codecell-vesit/mail-autosender-resumes-codecell
   ```

   Run `terraform plan` and compare the bucket's planned changes with
   `gcloud storage buckets describe gs://mail-autosender-resumes-codecell`. Settings that differ (storage class,
   versioning, public access prevention) are changed on apply: make sure each is intended before applying.

5. **Review and apply**:

   ```sh
   terraform plan -out=tfplan
   terraform apply tfplan
   ```

   First apply uses a public placeholder image and a throwaway "placeholder" version 1 in every secret
   (`seed_placeholder_secret_versions`) so Cloud Run can start before real values exist. Scheduler jobs are created paused,
   the services run a placeholder image until the first deploy (runtime config comes from `deploy/*.env.yaml`, set
   `DRY_RUN: "true"` there for a dry first deploy). If an apply fails right after creating service accounts with a "does not exist" IAM error, re-run it
   (IAM propagation).

6. **Add the real secret values** (read from stdin so they never reach shell history or state):

   ```sh
   printf '%s' "postgres://...prod pooled url..." | gcloud secrets versions add mail-database-url --data-file=-
   printf '%s' "you@gmail.com"                    | gcloud secrets versions add mail-gmail-user --data-file=-
   read -rs GMAIL_APP_PASSWORD; printf '%s' "$GMAIL_APP_PASSWORD" | gcloud secrets versions add mail-gmail-app-password --data-file=-; unset GMAIL_APP_PASSWORD
   openssl rand -hex 32                           | tr -d '\n' | gcloud secrets versions add mail-session-secret --data-file=-
   read -rs ADMIN_PASSWORD; printf '%s' "$ADMIN_PASSWORD" | gcloud secrets versions add mail-admin-password --data-file=-; unset ADMIN_PASSWORD
   gcloud secrets versions add mail-signature-html --data-file=signature.html
   gcloud secrets versions list mail-database-url   # every secret must show a version newer than the placeholder (1)
   ```

7. **GitHub repository variables** (variables, not secrets; none of these are sensitive):

   ```sh
   cd infra
   gh variable set GCP_PROJECT       --body codecell-vesit
   gh variable set GCP_REGION        --body asia-south1
   gh variable set WIF_PROVIDER      --body "$(terraform output -raw wif_provider)"
   gh variable set DEPLOY_SA         --body "$(terraform output -raw deployer_service_account)"
   gh variable set WIF_PROVIDER_PLAN --body "$(terraform output -raw wif_provider_plan)"
   gh variable set PLAN_SA           --body "$(terraform output -raw planner_service_account)"
   gh variable set ALERT_EMAIL       --body you@example.com
   gh variable set BILLING_ACCOUNT_ID --body XXXXXX-XXXXXX-XXXXXX   # optional, see "Budget alert"; leave unset to skip
   ```

   Also in the repo settings: create environment `production` with yourself as required reviewer, and protect `main`
   (pull request required; required status check `CI passed`, which is the exact check run name on pull requests).

8. First deploy: merge to `main` (or run the Deploy workflow). Continue with the go-live checklist in
   [`docs/deploy.md`](../docs/deploy.md). (Done for this project: it is live.)

## Day-to-day

* Infrastructure changes (schedules, alerts, IAM): edit `.tf`, open a PR (the `Terraform plan` workflow comments the diff),
  merge, then `terraform apply` locally. CI deliberately has no apply identity.
* Runtime changes (env vars such as `DRY_RUN`, resources, probes, secret references): edit `deploy/*.env.yaml` or
  `deploy.yml` in a PR; merging deploys them. Terraform never sees them, so there is nothing to apply and no drift.
* Image rollouts are never Terraform's job. After a rollback to a pinned revision, run
  `gcloud run services update-traffic <svc> --to-latest` (the next deploy does it too).
* `terraform plan` in CI uses `-refresh=false -lock=false` (config vs state; the read-only identity cannot read secret
  payloads or resources, and needs no state write). Run a full `terraform plan` locally now and then to see drift; against
  the live project it reports `No changes`.
* Scheduler `paused` is only honoured at creation. Pause/resume with `gcloud scheduler jobs pause|resume <name>`; that is also
  the emergency stop for sending (`docs/deploy.md` section 6).

## Budget alert (optional)

`billing_account_id` defaults to empty, which creates no budget. Setting it makes Terraform create a
`google_billing_budget`, and that needs **Billing Account Administrator** or **Billing Budgets creator** on the billing
account itself (project owner is not enough; without it the API answers 400, which is what happened here). Either get a billing
admin to run the apply with `billing_account_id = "XXXXXX-XXXXXX-XXXXXX"` (`gcloud billing accounts list`), or skip Terraform
and create the budget in the console: Billing > Budgets & alerts > Create budget, scope to project `codecell-vesit`, 10 USD
per month, thresholds 50% and 100% (and forecasted 100%), email to the alert address. The plan workflow's
`BILLING_ACCOUNT_ID` variable can stay unset.

## Notes and limits

* The "no successful reply sweep" alert uses a 23.5 h window because Cloud Monitoring caps absence conditions at 24 h.
  It is off until `sweep_alert_enabled = true` (dry-run sweeps are skipped and would alert).
* Hold/needs-review alerting keys on the `internal_tick` log line the app writes on every tick
  (`held`, `needsReview`, `failed`, `reason=paused`). It fires only while a window is processed, not from the database.
* `github-planner` is read-only: `roles/browser` (project metadata only), `serviceusage.serviceUsageConsumer`, and
  `roles/storage.objectViewer` on the state bucket. It cannot write or delete state, change anything in the project, or read
  secret payloads or the resume PDFs (it deliberately lacks `roles/viewer`). Any branch of the repo can run code as it, which is
  why it gets nothing more. If `terraform init` in the plan job fails with a bucket permission error, run plans locally instead
  of widening this role.
* WIF is pinned to the numeric repository id (`github_repository_id`: `gh api repos/OWNER/NAME --jq .id`). The deployer binding
  also requires the `deploy.yml` workflow file on `refs/heads/main`; never add a `pull_request_target` workflow.
