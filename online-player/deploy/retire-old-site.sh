#!/bin/sh
set -eu
systemctl is-active --quiet wisteria-online.service
test "$(readlink -f /opt/wisteria)" = /opt/wisteria
test "$(readlink -f /opt/wisteria/current)" = /opt/wisteria/releases/6042a48
test ! -e /opt/wisteria-retired-20260908
test -f /var/backups/wisteria-replacement-20260908/nginx-wisteria.conf
systemctl disable --now wisteria.service wisteria-backup.timer
systemctl stop wisteria-backup.service
install -d -m 700 /var/backups/wisteria-replacement-20260908/disabled-units
mv -- /etc/systemd/system/wisteria.service /etc/systemd/system/wisteria-backup.service /etc/systemd/system/wisteria-backup.timer /var/backups/wisteria-replacement-20260908/disabled-units/
mv -- /opt/wisteria /opt/wisteria-retired-20260908
chmod 700 /opt/wisteria-retired-20260908
systemctl daemon-reload
systemctl is-active wisteria-online.service nginx.service
