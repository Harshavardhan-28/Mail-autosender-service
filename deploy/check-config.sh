#!/usr/bin/env bash
# Lints deploy/*.env.yaml before they reach `gcloud run deploy --env-vars-file` (run by CI and by the Deploy workflow).
# Rules: only `KEY: "string"` lines (gcloud needs string values), no duplicate keys, no secret names (secrets come from
# Secret Manager), and the settings whose wrong value is dangerous must be present.
set -euo pipefail
cd "$(dirname "$0")"

secret_names="DATABASE_URL GMAIL_USER GMAIL_APP_PASSWORD SESSION_SECRET SIGNATURE_HTML ADMIN_PASSWORD"
fail=0
err() { echo "::error file=deploy/$1::$2"; fail=1; }

for f in backend.env.yaml web.env.yaml; do
  [ -f "$f" ] || { err "$f" "missing"; continue; }
  keys=""
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    if ! [[ "$line" =~ ^([A-Z][A-Z0-9_]*):\ \"[^\"]*\"([[:space:]]+#.*)?$ ]]; then
      err "$f" "not a KEY: \"string\" line (quote every value, one per line): $line"; continue
    fi
    key="${BASH_REMATCH[1]}"
    case " $keys " in *" $key "*) err "$f" "duplicate key $key" ;; esac
    keys="$keys $key"
    for s in $secret_names; do [ "$key" != "$s" ] || err "$f" "$key is a secret: reference it from Secret Manager, not this file"; done
  done < "$f"
  eval "keys_${f%%.*}=\"\$keys\""
done

need() { case " $keys_backend " in *" $1 "*) ;; *) err backend.env.yaml "required key $1 is missing" ;; esac; }
for k in NODE_ENV WORKER_MODE DRY_RUN TRUST_PROXY SEND_WINDOW_ENFORCED RESUME_BUCKET INTERNAL_AUDIENCE INTERNAL_INVOKER_SA; do need "$k"; done
case " $keys_web " in *" BACKEND_URL "*) ;; *) err web.env.yaml "required key BACKEND_URL is missing" ;; esac

# TRUST_PROXY must stay 1 (a public backend must not trust a client-supplied X-Forwarded-For entry).
grep -Eq '^TRUST_PROXY: "1"' backend.env.yaml || err backend.env.yaml 'TRUST_PROXY must be "1" (see docs/deploy.md)'

exit "$fail"
