#!/bin/sh
# Install beside an existing Squad MiniMax/Codex runtime on Ubuntu.
set -eu
host="${1:?Provide the public server hostname or IPv4 address}"
port="${2:-18443}"
printf '%s\n' "$host" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$'
printf '%s\n' "$port" | grep -Eq '^[0-9]{1,5}$'
[ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || exit 2
test "$(id -u)" -eq 0
test -x /opt/octopus-g0/bin/codex-minimax
test -s /etc/ssh/ssh_host_ed25519_key.pub
command -v sudo >/dev/null
test -x /usr/sbin/sshd
directory=/var/lib/squad-gateway
if ! id squad-gateway >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$directory" --shell /bin/sh squad-gateway
fi
test "$(getent passwd squad-gateway | cut -d: -f6)" = "$directory"
install -d -m 0755 /opt/squad-gateway
install -m 0755 "$(dirname "$0")/device-gateway.py" /opt/squad-gateway/device-gateway.py
install -d -o squad-gateway -g squad-gateway -m 0700 "$directory" "$directory/.ssh"
awk '{print $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub > "$directory/ssh-host.pub"
if [ ! -s "$directory/pairing.crt" ] || [ ! -s "$directory/pairing.key" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 730 -subj "/CN=$host" \
    -keyout "$directory/pairing.key" -out "$directory/pairing.crt" 2>/dev/null
fi
if [ ! -s "$directory/admin-password" ]; then
  ( umask 077; openssl rand -hex 24 > "$directory/admin-password" )
fi
chown squad-gateway:squad-gateway "$directory/ssh-host.pub" "$directory/pairing.crt" "$directory/pairing.key" "$directory/admin-password"
chmod 0600 "$directory/pairing.key" "$directory/admin-password"
rule=$(mktemp)
trap 'rm -f "$rule"' EXIT
cat > "$rule" <<'EOF'
squad-gateway ALL = (octopus-g0) NOPASSWD: /opt/octopus-g0/bin/codex-minimax app-server --stdio, /opt/octopus-g0/bin/codex-minimax squad-quota
EOF
visudo -cf "$rule" >/dev/null
install -m 0440 "$rule" /etc/sudoers.d/squad-gateway
cat > /opt/squad-gateway/sshd_config <<'EOF'
Port 18227
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
AllowUsers squad-gateway
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
UsePAM yes
DisableForwarding yes
PermitTTY no
PermitUserRC no
PermitUserEnvironment no
MaxSessions 1
LoginGraceTime 10
EOF
/usr/sbin/sshd -t -f /opt/squad-gateway/sshd_config
cat > /etc/systemd/system/squad-device-ssh.service <<'EOF'
[Unit]
Description=Restricted SSH service for Squad devices
After=network.target

[Service]
ExecStart=/usr/sbin/sshd -D -e -f /opt/squad-gateway/sshd_config
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/squad-gateway.service <<EOF
[Unit]
Description=Squad device enrollment and admin dashboard
After=network.target
Requires=squad-device-ssh.service
After=squad-device-ssh.service

[Service]
User=squad-gateway
Group=squad-gateway
UMask=0077
ExecStart=/usr/bin/python3 /opt/squad-gateway/device-gateway.py serve $host $port
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$directory
PrivateTmp=true
Restart=on-failure
TasksMax=72
MemoryMax=128M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable squad-gateway.service squad-device-ssh.service
systemctl restart squad-device-ssh.service
systemctl restart squad-gateway.service
systemctl is-active squad-gateway.service
