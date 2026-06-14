#!/bin/bash
set -e

CURRENT=$(git branch --show-current)
if [ "$CURRENT" != "development" ]; then
  echo "Error: must be on the development branch to deploy to prod (currently on '$CURRENT')"
  exit 1
fi

echo "→ Merging development into main..."
git checkout main
git merge development --ff-only
git push origin main
git checkout development

echo "→ Deploying to your-domain.example.com..."
ssh -i ~/.ssh/id_ed25519_deploy deploy@your-server.example.com '
  cd /opt/health-dashboard &&
  git fetch origin &&
  git checkout main &&
  git pull origin main &&
  cd server && npm install --omit=dev &&
  sudo systemctl restart health-dashboard
'

echo "✓ Prod deployed → https://your-domain.example.com"
