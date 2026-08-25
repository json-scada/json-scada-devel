#!/bin/bash
#
# {json:scada} - migrate legacy supervisor driver program files into the manager-owned
# directory so protocol driver services can be created / altered / removed from the
# AdminUI (process management). Run once, with sudo, on an existing install.
#
# What it does:
#   - moves protocol-driver *.ini files from the system supervisor include dir
#     (/etc/supervisord.d on RHEL, /etc/supervisor/conf.d on Ubuntu) into
#     ~/json-scada/conf/supervisor.d, owned by the jsonscada user;
#   - leaves core service files (mongodb, postgres, nginx, auth server, ...) in place;
#   - reloads supervisor so nothing restarts unexpectedly.
#
# Usage: sudo ./migrate_supervisor_inis.sh [jsonscada_user] [json_scada_dir]

set -e

JS_USER="${1:-jsonscada}"
JS_DIR="${2:-/home/$JS_USER/json-scada}"
MANAGED_DIR="$JS_DIR/conf/supervisor.d"

# Detect the system include directory.
if [ -d /etc/supervisord.d ]; then
  SYS_DIR=/etc/supervisord.d
elif [ -d /etc/supervisor/conf.d ]; then
  SYS_DIR=/etc/supervisor/conf.d
else
  echo "Could not find the supervisor include directory (/etc/supervisord.d or /etc/supervisor/conf.d)."
  exit 1
fi

# Program base names that correspond to manageable protocol drivers. Keep in sync
# with the process manager driver catalog keys.
DRIVER_KEYS="iec104client iec104server iec101client iec101server dnp3client dnp3server \
iec61850client iccpclient iccpserver mqttsparkplugclient mqtt-sparkplug opcuaclient \
opcuaserver opcdaclient plctags plc4xclient plc4jclient telegraf-listener telegraf_listener \
i104m onvif modbusclient modbusserver nodered_driver n8nclient"

echo "Migrating legacy supervisor driver files:"
echo "  from: $SYS_DIR"
echo "  to:   $MANAGED_DIR (owned by $JS_USER)"

mkdir -p "$MANAGED_DIR"
chown "$JS_USER":"$JS_USER" "$MANAGED_DIR"

moved=0
for key in $DRIVER_KEYS; do
  for f in "$SYS_DIR/$key.ini"; do
    if [ -f "$f" ]; then
      dest="$MANAGED_DIR/$(basename "$f")"
      if [ -f "$dest" ]; then
        echo "  skip (already managed): $(basename "$f")"
        continue
      fi
      mv "$f" "$dest"
      chown "$JS_USER":"$JS_USER" "$dest"
      echo "  moved: $(basename "$f")"
      moved=$((moved + 1))
    fi
  done
done

echo "Moved $moved file(s). Reloading supervisor..."
supervisorctl reread || true
supervisorctl update || true
echo "Done. Driver services can now be managed from the AdminUI."
