#!/usr/bin/env bash
set -euo pipefail

: "${FIXOPS_AGENT_TOKEN:?Set FIXOPS_AGENT_TOKEN before installing}"
: "${FIXOPS_PROJECT_ROOT:?Set FIXOPS_PROJECT_ROOT before installing}"
FIXOPS_DIR="${FIXOPS_DIR:-/opt/fixops-agent}"
mkdir -p "$FIXOPS_DIR"
cp -R packages apps package.json pnpm-workspace.yaml tsconfig.base.json "$FIXOPS_DIR/"
cd "$FIXOPS_DIR"
corepack enable
pnpm install --ignore-scripts
pnpm --filter @fixops/agent... build
cat > /etc/systemd/system/fixops-agent.service <<EOF
[Unit]
Description=FixOps host agent
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=$FIXOPS_DIR
Environment=AGENT_HOST=0.0.0.0
Environment=AGENT_PORT=4318
Environment=AGENT_ENROLLMENT_TOKEN=$FIXOPS_AGENT_TOKEN
Environment=FIXOPS_PROJECT_ROOT=$FIXOPS_PROJECT_ROOT
Environment=FIXOPS_DATA_DIR=$FIXOPS_DIR/data
ExecStart=$(command -v node) $FIXOPS_DIR/packages/agent/dist/cli.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now fixops-agent
echo "FixOps Agent installed. Restrict TCP/4318 to the control-plane host."
