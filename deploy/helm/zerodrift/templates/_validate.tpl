{{/* Refuse unsafe or incomplete combinations at `helm template` / `helm install` time, with a message that says what to change. */}}
{{- define "zerodrift.validate" -}}
{{- $s := .Values.services -}}
{{- if and (eq .Values.nodeEnv "production") (index $s "chaos-controller").enabled -}}
{{- fail "services.chaos-controller.enabled=true with nodeEnv=production: the chaos controller breaks things on purpose, it is a test tool and must never run in production" -}}
{{- end -}}
{{- if and (index $s "dashboard-api").enabled (not .Values.secrets.existingSecret) (or (not .Values.secrets.jwtSecret) (not .Values.secrets.dashboardPassword)) -}}
{{- fail "services.dashboard-api.enabled=true needs secrets.jwtSecret and secrets.dashboardPassword (or secrets.existingSecret with keys jwtSecret and dashboardPassword)" -}}
{{- end -}}
{{- if and (index $s "demo-shop").enabled (not (index $s "demo-shop").env.PUBLIC_URL) -}}
{{- fail "services.demo-shop.enabled=true needs services.demo-shop.env.PUBLIC_URL (the public https URL webhooks reach the shop on)" -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.hosts.api) (not .Values.ingress.hosts.console) -}}
{{- fail "ingress.enabled=true needs at least ingress.hosts.api or ingress.hosts.console" -}}
{{- end -}}
{{- end }}
