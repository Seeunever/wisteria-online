#!/bin/sh
set -eu
test ! -e /opt/wisteria-online/current
test ! -e /etc/wisteria-online.env
test ! -e /etc/systemd/system/wisteria-online.service
test ! -e /var/lib/wisteria-online
test ! -e /var/backups/wisteria-online
test -f /opt/wisteria-online/incoming/release.tar.gz
chmod 755 /opt/wisteria-online
install -d -m 755 /opt/wisteria-online/releases/20260908-online-v1
tar -xzf /opt/wisteria-online/incoming/release.tar.gz -C /opt/wisteria-online/releases/20260908-online-v1
chown -R root:wisteria /opt/wisteria-online/releases/20260908-online-v1
chmod -R o-rwx /opt/wisteria-online/releases/20260908-online-v1
ln -s /opt/wisteria-online/releases/20260908-online-v1 /opt/wisteria-online/current
install -d -o wisteria -g wisteria -m 700 /var/lib/wisteria-online /var/backups/wisteria-online
node /opt/wisteria-online/current/deploy/create-env.mjs
chown root:wisteria /etc/wisteria-online.env
chmod 640 /etc/wisteria-online.env
install -m 644 /opt/wisteria-online/current/deploy/wisteria-online.service /etc/systemd/system/wisteria-online.service
systemctl daemon-reload
systemctl start wisteria-online.service
systemctl is-active wisteria-online.service
