#!/bin/bash
pids=$(ss -tlnp 2>/dev/null | grep ':3210' | grep -oP 'pid=\K[0-9]+' | sort -u)
if [ -n "$pids" ]; then
  kill $pids 2>/dev/null
  sleep 1
fi
cd /opt/whoapi
nohup env PORT=3210 FLARESOLVERR_URL=http://127.0.0.1:8191/v1 ANIPM_PROXY_URL=http://127.0.0.1:8095 node server.js > /tmp/whoapi-test.log 2>&1 &
sleep 2
curl -s -m 5 http://127.0.0.1:3210/health
