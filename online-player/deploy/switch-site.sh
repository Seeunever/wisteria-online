#!/bin/sh
set -eu
test "$(readlink -f /etc/nginx/sites-enabled/wisteria)" = /etc/nginx/sites-available/wisteria
test "$(readlink -f /opt/wisteria/current)" = /opt/wisteria/releases/6042a48
test ! -e /var/backups/wisteria-replacement-20260908
systemctl is-active --quiet wisteria-online.service
curl -fsS --max-time 5 http://127.0.0.1:4310/ -o /dev/null
install -d -m 700 /var/backups/wisteria-replacement-20260908
cp -a /etc/nginx/sites-available/wisteria /var/backups/wisteria-replacement-20260908/nginx-wisteria.conf
cp -a /etc/systemd/system/wisteria.service /var/backups/wisteria-replacement-20260908/wisteria.service
install -m 644 /opt/wisteria-online/current/deploy/nginx-wisteria.conf /etc/nginx/sites-available/wisteria
if ! nginx -t; then
    cp -a /var/backups/wisteria-replacement-20260908/nginx-wisteria.conf /etc/nginx/sites-available/wisteria
    exit 1
fi
if ! systemctl reload nginx; then
    cp -a /var/backups/wisteria-replacement-20260908/nginx-wisteria.conf /etc/nginx/sites-available/wisteria
    systemctl reload nginx
    exit 1
fi
systemctl enable wisteria-online.service
# Old service is deliberately retained until public HTTPS checks pass.
