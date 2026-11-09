#!/usr/bin/env sh
# Generates Netlify redirects: proxy /api/* to the backend, SPA fallback for everything else.
set -e
if [ -z "$API_ORIGIN" ]; then
  echo "API_ORIGIN is not set. Add it in Netlify > Site configuration > Environment variables." >&2
  exit 1
fi
API_ORIGIN="${API_ORIGIN%/}"
{
  echo "/api/*  ${API_ORIGIN}/api/:splat  200"
  echo "/*      /index.html  200"
} > dist/_redirects
echo "wrote dist/_redirects -> ${API_ORIGIN}"
