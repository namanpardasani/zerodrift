{{- define "zerodrift.secretName" -}}
{{- if .Values.secrets.existingSecret -}}{{ .Values.secrets.existingSecret }}{{- else -}}zerodrift-secrets{{- end -}}
{{- end }}

{{- define "zerodrift.image" -}}
{{- $root := index . 0 -}}{{- $name := index . 1 -}}{{- $svc := index . 2 -}}
{{ $root.Values.image.registry }}{{ $root.Values.image.prefix }}{{ default $name $svc.image }}:{{ $root.Values.image.tag }}
{{- end }}

{{- define "zerodrift.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: zerodrift
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ .root.Chart.Name }}-{{ .root.Chart.Version }}
{{- end }}
