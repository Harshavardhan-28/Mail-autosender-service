variable "project_id" {
  description = "GCP project that hosts everything."
  type        = string
  default     = "codecell-vesit"
}

variable "region" {
  description = "Region for Cloud Run, Scheduler, Artifact Registry and secret replicas (Mumbai)."
  type        = string
  default     = "asia-south1"
}

variable "state_bucket" {
  description = "Existing Terraform state bucket (created by hand). Only used to grant the plan identity access."
  type        = string
  default     = "codecell-vesit-tfstate"
}

variable "github_repo" {
  description = "GitHub repository (owner/name) allowed to authenticate through Workload Identity Federation."
  type        = string
  default     = "Harshavardhan-28/Mail-autosender-service"
}

variable "github_repository_id" {
  description = "Numeric, immutable GitHub repository id (`gh api repos/OWNER/NAME --jq .id`). Pinned in the WIF conditions so a renamed or recreated repo with the same name cannot authenticate."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be the numeric repository id."
  }
}

variable "github_branch" {
  description = "The only branch whose workflows may impersonate the deployer service account."
  type        = string
  default     = "main"
}

variable "resume_bucket_name" {
  description = "Existing resume bucket (import it, do not recreate)."
  type        = string
  default     = "mail-autosender-resumes-codecell"
}

variable "alert_email" {
  description = "Address that receives alert and budget emails."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "billing_account_id" {
  description = <<-EOT
    OPTIONAL. Billing account id (XXXXXX-XXXXXX-XXXXXX) for the budget alert. Empty (the default) = no budget resource.
    Creating a budget needs Billing Account Administrator (or Billing Budgets creator) on the BILLING ACCOUNT, not just
    project owner; without it the API answers 400. Create the budget in the console instead (infra/README.md).
  EOT
  type        = string
  default     = ""
}

variable "budget_amount_usd" {
  description = "Monthly budget in whole USD. Alerts fire at 50% and 100% (and forecasted 100%)."
  type        = number
  default     = 10
}

variable "scheduler_paused" {
  description = <<-EOT
    Initial state of the Cloud Scheduler jobs at CREATION. After that Terraform ignores the paused flag,
    so an emergency `gcloud scheduler jobs pause` is never reverted by a later apply.
  EOT
  type        = bool
  default     = true
}

variable "sweep_alert_enabled" {
  description = "Enable the 'no successful reply sweep in ~24h' alert. Leave false until real sweeps have run once (dry-run sweeps are skipped, which would page you)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Cloud Run service/job deletion protection. Set false only to tear the stack down."
  type        = bool
  default     = true
}

variable "seed_placeholder_secret_versions" {
  description = <<-EOT
    Create a throwaway version 1 ("placeholder") in each secret so Cloud Run can start before real values exist.
    Real values are added with `gcloud secrets versions add`; "latest" then resolves to them.
  EOT
  type        = bool
  default     = true
}

# --- Images and runtime config (GitOps: the deploy workflow owns them after the first apply, see deploy/) -----------------------------------------------------------
variable "placeholder_image" {
  description = "Public image used only for the first apply. The deploy workflow rolls out the real SHA-tagged images and runtime config; Terraform ignores the service template."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "admin_username" {
  description = "ADMIN_USERNAME for the one-off seed-admin job (the password lives in Secret Manager)."
  type        = string
  default     = "admin"
}

variable "reply_sweep_schedules" {
  description = "Reply sweep cron schedules (Asia/Kolkata). The 08:50 one lets follow-ups through right before the send window."
  type        = map(string)
  default = {
    "reply-sweep-0850" = "50 8 * * *"
    "reply-sweep-1000" = "0 10 * * *"
    "reply-sweep-1320" = "20 13 * * *"
    "reply-sweep-1640" = "40 16 * * *"
    "reply-sweep-2000" = "0 20 * * *"
  }
}

variable "send_window_schedule" {
  description = "Cron for /internal/tick (Asia/Kolkata). The app additionally enforces the send window itself, so if the Settings window changes this cron must change too or nothing sends."
  type        = string
  default     = "*/5 9 * * *"
}
