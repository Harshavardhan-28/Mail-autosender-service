locals {
  # Cloud Run's deterministic service URL (https://<service>-<project number>.<region>.run.app). Computing it up front
  # avoids a self-reference (the scheduler's OIDC audience must equal the service's own URL) and a two-step bootstrap.
  backend_url = "https://mail-backend-${data.google_project.this.number}.${var.region}.run.app"
  web_url     = "https://mail-web-${data.google_project.this.number}.${var.region}.run.app"

  repo_path = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

# Terraform owns the service SHELL only: name, ingress, service account, IAM and (at creation) a bootstrap template.
# The runtime configuration (image, env vars, secret references, resources, probes, timeout, concurrency, scaling bounds)
# is GitOps: it lives in deploy/*.env.yaml and the flags in .github/workflows/deploy.yml, and every deploy applies it.
# `ignore_changes = [template]` is what stops the two writers colliding (Terraform re-sending a revision name that the
# deploy workflow had already created is a 409 "Revision ... with different configuration already exists").
# The template below therefore only matters on the very first apply.
resource "google_cloud_run_v2_service" "backend" {
  project             = var.project_id
  name                = "mail-backend"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.backend.email

    scaling {
      min_instance_count = 0
      max_instance_count = 1 # single-writer worker; the deploy workflow enforces the same bound
    }

    containers {
      image = var.placeholder_image
      ports {
        container_port = 8080
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template,
      traffic,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.placeholder,
    google_secret_manager_secret_iam_member.backend,
    google_storage_bucket_iam_member.backend_resumes,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  project             = var.project_id
  name                = "mail-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.web.email

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.placeholder_image
      ports {
        container_port = 8080
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template,
      traffic,
      client,
      client_version,
    ]
  }
}

# The browser reaches both services anonymously: mail-web serves the UI, and its /api/* rewrite calls mail-backend without
# an IAM token. mail-backend authenticates callers itself (session + CSRF; /internal/* only accepts the scheduler's OIDC token).
# If the org policy blocks allUsers (domain restricted sharing), this is where the deploy will fail.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Jobs: run to completion before each rollout (migrate) or once on demand (seed-admin) ---------------------
resource "google_cloud_run_v2_job" "migrate" {
  project             = var.project_id
  name                = "mail-migrate"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    template {
      service_account = google_service_account.migrate.email
      max_retries     = 0 # a failed migration must stop the deploy, not be retried blindly
      timeout         = "600s"

      containers {
        image   = var.placeholder_image
        command = ["node"]
        args    = ["src/db/migrate.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["DATABASE_URL"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.placeholder,
    google_secret_manager_secret_iam_member.migrate,
  ]
}

# Creates or resets the admin user (scripts/seedAdmin.js also applies pending migrations). Idempotent; run on demand:
#   gcloud run jobs execute mail-seed-admin --region asia-south1 --wait
resource "google_cloud_run_v2_job" "seed_admin" {
  project             = var.project_id
  name                = "mail-seed-admin"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    template {
      service_account = google_service_account.migrate.email
      max_retries     = 0
      timeout         = "300s"

      containers {
        image   = var.placeholder_image
        command = ["node"]
        args    = ["scripts/seedAdmin.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }

        env {
          name  = "ADMIN_USERNAME"
          value = var.admin_username
        }

        dynamic "env" {
          for_each = toset(local.migrate_secret_env)
          content {
            name = env.value
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.app[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.placeholder,
    google_secret_manager_secret_iam_member.migrate,
  ]
}
