#!/usr/bin/env bash
# Creates the two Secrets Manager secrets aws/infra/lib/api-stack.ts
# references by name but never creates the *value* of (a human decision,
# not something code should generate blindly). Safe to re-run — skips a
# secret that already exists rather than overwriting it.
#
# Usage: ./create-secrets.sh <env> [razorpay-key-id] [razorpay-key-secret] [razorpay-webhook-secret]
#   ./create-secrets.sh dev                              # website key only, Razorpay gets placeholders (mock mode)
#   ./create-secrets.sh dev rzp_test_xxx xxx webhooksecret

set -euo pipefail
ENV="${1:?Usage: create-secrets.sh <env> [razorpay-key-id] [razorpay-key-secret] [razorpay-webhook-secret]}"
RZP_KEY_ID="${2:-rzp_test_placeholder}"
RZP_KEY_SECRET="${3:-placeholder}"
RZP_WEBHOOK_SECRET="${4:-placeholder}"

exists() { aws secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1; }

WEBSITE_KEY_NAME="nlpos-${ENV}/website-api-key"
if exists "$WEBSITE_KEY_NAME"; then
  echo "skip: $WEBSITE_KEY_NAME already exists"
else
  KEY=$(openssl rand -hex 32)
  aws secretsmanager create-secret --name "$WEBSITE_KEY_NAME" --secret-string "$KEY" >/dev/null
  echo "created: $WEBSITE_KEY_NAME"
  echo "  -> give this value to the Website team as their X-API-Key: $KEY"
fi

RZP_NAME="nlpos-${ENV}/razorpay"
if exists "$RZP_NAME"; then
  echo "skip: $RZP_NAME already exists"
else
  aws secretsmanager create-secret --name "$RZP_NAME" \
    --secret-string "{\"keyId\":\"$RZP_KEY_ID\",\"keySecret\":\"$RZP_KEY_SECRET\",\"webhookSecret\":\"$RZP_WEBHOOK_SECRET\"}" >/dev/null
  echo "created: $RZP_NAME"
  if [ "$RZP_KEY_ID" = "rzp_test_placeholder" ]; then
    echo "  -> placeholder values — deploy with --context paymentProvider=mock --context allowMockPayments=true"
    echo "     update later with: aws secretsmanager put-secret-value --secret-id $RZP_NAME --secret-string '{...real keys...}'"
  fi
fi
