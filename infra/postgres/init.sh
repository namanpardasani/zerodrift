#!/bin/bash
# One database per service: no cross-service table access (brief section 3).
set -e
for db in ledger payments webhook reconciliation; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE $db;"
done
