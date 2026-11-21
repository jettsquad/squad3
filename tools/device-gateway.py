#!/usr/bin/env python3
"""Squad device enrollment, admin dashboard, and restricted SSH entry point."""
import base64
import calendar
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import select
import socket
import signal
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

HOME = Path(os.environ.get("SQUAD_GATEWAY_HOME", "/var/lib/squad-gateway"))
PROGRAM = "/opt/octopus-g0/bin/codex-minimax"
ENTRY = "/opt/squad-gateway/device-gateway.py"
USER = "octopus-g0"
ADMIN_PORT = 18226
DEVICE_SSH_PORT = 18227
LOCK = threading.Lock()
TRIAL_SECONDS = 10 * 86400


@contextmanager
def database():
    conn = sqlite3.connect(HOME / "devices.sqlite", timeout=5)
    conn.row_factory = sqlite3.Row
    with closing(conn), conn:
        yield conn


def setup():
    with database() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS accounts (
                name TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS device_accounts (
                device TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(name));
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT UNIQUE NOT NULL,
                expires INTEGER, state TEXT NOT NULL DEFAULT 'active',
                stop INTEGER NOT NULL DEFAULT 0, seen INTEGER);
            CREATE TABLE IF NOT EXISTS audit (
                at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY, device TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS activations (source TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS trial_devices (device TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS subscriptions (
                id TEXT PRIMARY KEY, device TEXT NOT NULL, term TEXT NOT NULL,
                status TEXT NOT NULL, requested INTEGER NOT NULL, reviewed INTEGER);
            CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_pending
                ON subscriptions(device) WHERE status='pending';
        """)


def audit(db, action, target):
    db.execute("INSERT INTO audit VALUES (?, ?, ?)", (int(time.time()), action, target))
    db.execute("DELETE FROM audit WHERE rowid <= (SELECT max(rowid) - 1000 FROM audit)")


def state(device):
    if device["state"] != "active":
        return device["state"]
    return "expired" if device["expires"] is not None and device["expires"] <= time.time() else "active"


def publish_keys(db):
    # The forced command is machine generated. A key cannot request a shell, PTY, or forwarding.
    rows = db.execute("SELECT id, public_key FROM devices")
    content = "".join(f'restrict,command="/usr/bin/python3 {ENTRY} ssh {r["id"]}" {r["public_key"]}\n' for r in rows)
    partial = HOME / ".ssh/authorized_keys.tmp"
    partial.write_text(content, encoding="ascii")
    partial.chmod(0o600)
    partial.replace(HOME / ".ssh/authorized_keys")


def access_device(db, identity):
    return db.execute(
        "SELECT d.*, da.account, a.enabled, t.device AS trial FROM devices AS d "
        "LEFT JOIN device_accounts AS da ON d.id=da.device "
        "LEFT JOIN trial_devices AS t ON d.id=t.device "
        "LEFT JOIN accounts AS a ON da.account=a.name WHERE d.id=?", (identity,)
    ).fetchone()


def access_state(device):
    current = state(device)
    if current in ("active", "expired") and not (device["enabled"] or device["trial"]):
        return "paused"
    return current


def enroll(payload, source, trial=False):
    public = payload.get("publicKey")
    account, password, name = (payload.get(field) for field in ("account", "password", "name"))
    if not isinstance(public, str) or not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]{68}", public):
        raise ValueError()
    if not base64.b64decode(public.split()[1], validate=True).startswith(b"\0\0\0\x0bssh-ed25519\0\0\0 "):
        raise ValueError()
    if not trial and (not isinstance(account, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,39}", account)):
        raise ValueError()
    if not trial and (not isinstance(password, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32}", password)):
        raise ValueError()
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or any(ord(char) < 32 for char in name):
        raise ValueError()
    name = name.strip()
    with LOCK, database() as db:
        if not trial:
            user = db.execute("SELECT * FROM accounts WHERE name=?", (account,)).fetchone()
            if user is None or not user["enabled"] or not hmac.compare_digest(
                user["secret_hash"], hashlib.sha256(password.encode()).hexdigest()
            ):
                raise ValueError()
        now = int(time.time())
        key = (HOME / "ssh-host.pub").read_text().strip()
        current = db.execute(
            "SELECT d.id, da.account, t.device AS trial FROM devices d LEFT JOIN device_accounts da ON d.id=da.device "
            "LEFT JOIN trial_devices t ON d.id=t.device WHERE d.public_key=?", (public,)
        ).fetchone()
        if current is not None:
            if not (current["trial"] if trial else current["account"] == account):
                raise ValueError()
            return {"deviceId": current["id"], "sshKey": key, "sshHost": HOST, "sshPort": PORT}
        db.execute("DELETE FROM activations WHERE at <= ?", (now - 3600,))
        if db.execute("SELECT count(*) FROM activations WHERE source=?", (source,)).fetchone()[0] >= 20:
            raise ValueError()
        if db.execute("SELECT count(*) FROM devices").fetchone()[0] >= 200:
            raise ValueError()
        count = db.execute(
            "SELECT count(*) FROM devices d JOIN device_accounts da ON d.id=da.device "
            "WHERE da.account=? AND d.state!='revoked' AND (d.expires IS NULL OR d.expires>?)", (account, now)
        ).fetchone()[0] if not trial else 0
        if count >= 5:
            raise ValueError()
        identity = secrets.token_hex(16)
        db.execute("INSERT INTO activations VALUES (?,?)", (source, now))
        db.execute("INSERT INTO devices (id,name,public_key,expires) VALUES (?,?,?,?)",
                   (identity, name, public, now + TRIAL_SECONDS))
        if trial:
            db.execute("INSERT INTO trial_devices VALUES (?)", (identity,))
        else:
            db.execute("INSERT INTO device_accounts VALUES (?,?)", (identity, account))
        audit(db, "自动授权 10 天", f'{account if not trial else "免登录试用"} · {name} · {identity[:8]}')
        publish_keys(db)
    return {"deviceId": identity, "sshKey": key, "sshHost": HOST, "sshPort": PORT}


def timestamp(value):
    return "—" if value is None else datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def subscription(device, term=None):
    with LOCK, database() as db:
        device = access_device(db, device["id"])
        pending = db.execute("SELECT * FROM subscriptions WHERE device=? AND status='pending'", (device["id"],)).fetchone()
        if term and pending and pending["term"] != term:
            raise ValueError("已有待审核申请")
        if term and not pending:
            if access_state(device) not in ("active", "expired") or device["expires"] is None:
                raise ValueError("当前设备不接受订阅申请")
            db.execute("INSERT INTO subscriptions VALUES (?,?,?,?,?,NULL)",
                       (secrets.token_hex(16), device["id"], term, "pending", int(time.time())))
            audit(db, "申请订阅", f'{device["name"]} · {device["id"][:8]} · {term}')
        latest = db.execute("SELECT * FROM subscriptions WHERE device=? ORDER BY rowid DESC LIMIT 1", (device["id"],)).fetchone()
        expiry = device["expires"]
        return {"state": access_state(device), "expiresAt": expiry * 1000 if expiry is not None else None,
                "request": None if latest is None else {
                    "term": latest["term"], "status": latest["status"], "requestedAt": latest["requested"] * 1000}}


def review_subscription(db, request_id, approve, now):
    item = db.execute("SELECT * FROM subscriptions WHERE id=? AND status='pending'", (request_id,)).fetchone()
    if item is None:
        raise ValueError()
    device = access_device(db, item["device"])
    if approve:
        if access_state(device) not in ("active", "expired") or device["expires"] is None:
            raise ValueError()
        base = datetime.fromtimestamp(max(now, device["expires"]), timezone.utc)
        index = (base.month - 1) + (1 if item["term"] == "month" else 12)
        year, month = base.year + index // 12, index % 12 + 1
        until = base.replace(year=year, month=month, day=min(base.day, calendar.monthrange(year, month)[1]))
        db.execute("UPDATE devices SET expires=? WHERE id=?", (int(until.timestamp()), device["id"]))
    db.execute("UPDATE subscriptions SET status=?,reviewed=? WHERE id=?",
               ("approved" if approve else "rejected", now, request_id))
    audit(db, "批准订阅" if approve else "拒绝订阅", f'{device["name"]} · {device["id"][:8]} · {item["term"]}')


def dashboard(code=""):
    with database() as db:
        rows = db.execute(
            "SELECT d.*, da.account, a.enabled, t.device AS trial FROM devices d LEFT JOIN device_accounts da ON d.id=da.device "
            "LEFT JOIN accounts a ON da.account=a.name LEFT JOIN trial_devices t ON d.id=t.device ORDER BY d.rowid DESC"
        ).fetchall()
        pending = db.execute(
            "SELECT s.*, d.name, d.expires FROM subscriptions s JOIN devices d ON d.id=s.device "
            "WHERE s.status='pending' ORDER BY s.requested"
        ).fetchall()
        accounts = db.execute("SELECT name, enabled FROM accounts ORDER BY name").fetchall()
        history = db.execute("SELECT * FROM audit ORDER BY rowid DESC LIMIT 30").fetchall()
    esc = html.escape
    labels = {"active": "有效", "paused": "已暂停", "revoked": "已撤销", "expired": "已到期"}
    hidden = f'<input type="hidden" name="csrf" value="{CSRF}">'
    devices = ""
    for row in rows:
        current = access_state(row)
        controls = ""
        if current != "revoked":
            controls = (f'<form method="post">{hidden}<input type="hidden" name="id" value="{row["id"]}">'
                        '<input name="days" type="number" min="0" max="3650" value="10" aria-label="授权天数">'
                        '<button name="op" value="set-duration">重设期限</button>'
                        '<button name="op" value="renew">续期</button>'
                        + ('<button name="op" value="resume">恢复</button>' if row["state"] == "paused" else
                           '<button name="op" value="pause">暂停</button>')
                        + '<button name="op" value="revoke">撤销</button>'
                          '<label><input type="checkbox" name="stop" value="1">撤销时断开正在运行的轮次</label></form>')
        devices += (f'<tr><td>{esc(row["name"])} · {row["id"][:8]}</td><td>{esc(row["account"] or ("免登录" if row["trial"] else "未绑定账号"))}</td><td>{labels[current]}</td>'
                    f'<td>{timestamp(row["expires"]) if row["expires"] is not None else "长期"}</td>'
                    f'<td>{timestamp(row["seen"])}</td><td>{controls}</td></tr>')
    logs = "".join(f'<li>{timestamp(r["at"])} · {esc(r["action"])} · {esc(r["target"])}</li>' for r in history)
    credential = f'<p>请通过可信渠道交给账号使用人。密码只显示一次。</p><textarea readonly rows="3">{esc(code)}</textarea>' if code else ""
    users = ""
    for user in accounts:
        op = "disable-account" if user["enabled"] else "enable-account"
        label = "暂停账号" if user["enabled"] else "恢复账号"
        name = esc(user["name"], quote=True)
        users += (f'<form method="post">{hidden}<input type="hidden" name="account" value="{name}">'
                  f'<strong>{name}</strong> <button name="op" value="{op}">{label}</button>'
                  '<button name="op" value="reset-account">重置登录密码</button></form>')
    reviews = ""
    for item in pending:
        term = "1 个月" if item["term"] == "month" else "1 年"
        reviews += (f'<form method="post">{hidden}<input type="hidden" name="request" value="{item["id"]}">'
                    f'<strong>{esc(item["name"])} · {item["device"][:8]} · {term}</strong>'
                    f'<span> · 申请于 {timestamp(item["requested"])} · 当前到期 {timestamp(item["expires"])}</span>'
                    '<button name="op" value="approve-subscription">批准</button>'
                    '<button name="op" value="reject-subscription">拒绝</button></form>')
    return (f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Squad 设备管理</title>'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:1200px}'
            'table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border-bottom:1px solid #ccc;text-align:left}'
            'button,input,textarea{font:inherit;margin:.2rem}textarea{width:min(100%,48rem)}</style>'
            '<h1>Squad 设备管理</h1><h2>订阅待审核</h2>'
            f'{reviews or "<p>没有待审核申请。</p>"}'
            '<h2>旧版账号</h2>'
            f'<form method="post">{hidden}<input name="account" maxlength="40" required pattern="[a-z0-9][a-z0-9_.-]*" '
            'placeholder="账号名（小写字母或数字起始）" aria-label="账号名">'
            '<button name="op" value="create-account">发放账号</button></form>'
            f'{credential}{users}<h2>设备</h2><p>重设期限从今天起算，填 0 表示长期。</p>'
            '<table><tr><th>名称</th><th>账号</th><th>状态</th><th>到期时间</th><th>最近连接</th>'
            f'<th>操作</th></tr>{devices}</table><h2>最近操作</h2><ul>{logs}</ul></html>')


def manage(form):
    field = lambda name: form.get(name, [""])[0]
    if not hmac.compare_digest(field("csrf").encode(), CSRF.encode()):
        raise ValueError()
    op = field("op")
    days = field("days")
    if op in ("renew", "set-duration") and (not re.fullmatch(r"[0-9]{1,4}", days) or int(days) > 3650):
        raise ValueError()
    now = int(time.time())
    with LOCK, database() as db:
        if op in ("approve-subscription", "reject-subscription"):
            review_subscription(db, field("request"), op == "approve-subscription", now)
            return ""
        if op in ("create-account", "disable-account", "enable-account", "reset-account"):
            name = field("account").strip()
            if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,39}", name):
                raise ValueError()
            user = db.execute("SELECT * FROM accounts WHERE name=?", (name,)).fetchone()
            if op == "create-account":
                if user is not None:
                    raise ValueError()
                password = secrets.token_urlsafe(24)
                db.execute("INSERT INTO accounts (name,secret_hash) VALUES (?,?)",
                           (name, hashlib.sha256(password.encode()).hexdigest()))
                audit(db, "发放账号", name)
                return f"账号：{name}\n密码：{password}"
            if user is None:
                raise ValueError()
            if op == "reset-account":
                password = secrets.token_urlsafe(24)
                db.execute("UPDATE accounts SET secret_hash=? WHERE name=?",
                           (hashlib.sha256(password.encode()).hexdigest(), name))
                audit(db, "重置登录密码", name)
                return f"账号：{name}\n密码：{password}"
            db.execute("UPDATE accounts SET enabled=? WHERE name=?", (int(op == "enable-account"), name))
            audit(db, "恢复账号" if op == "enable-account" else "暂停账号", name)
            return ""
        row = db.execute("SELECT * FROM devices WHERE id=?", (field("id"),)).fetchone()
        if row is None or row["state"] == "revoked":
            raise ValueError()
        if op == "renew":
            base = max(now, row["expires"] or now)
            db.execute("UPDATE devices SET expires=? WHERE id=?", (base + int(days) * 86400 if int(days) else None, row["id"]))
        elif op == "set-duration":
            db.execute("UPDATE devices SET expires=? WHERE id=?", (now + int(days) * 86400 if int(days) else None, row["id"]))
        elif op == "pause":
            db.execute("UPDATE devices SET state='paused' WHERE id=?", (row["id"],))
        elif op == "resume":
            db.execute("UPDATE devices SET state='active' WHERE id=?", (row["id"],))
        elif op == "revoke":
            db.execute("UPDATE devices SET state='revoked', stop=? WHERE id=?", (int(field("stop") == "1"), row["id"]))
        else:
            raise ValueError()
        detail = {"renew": "续期", "set-duration": "重设期限", "pause": "暂停", "resume": "恢复", "revoke": "撤销"}[op]
        if op in ("renew", "set-duration"):
            detail += f" · {days} 天" if int(days) else " · 长期"
        audit(db, detail, f'{row["name"]} · {row["id"][:8]}')
    return ""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def answer(self, status, body="", mime="text/plain", **headers):
        raw = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        for name, value in headers.items():
            self.send_header(name.replace("_", "-"), value)
        self.end_headers()
        self.wfile.write(raw)

    def auth(self):
        if hmac.compare_digest(self.headers.get("Authorization", "").encode(), ADMIN_AUTH):
            return True
        self.answer(401, "Squad admin login required.", WWW_Authenticate='Basic realm="Squad Admin"')
        return False

    def do_GET(self):
        if self.server.is_admin and self.path == "/":
            if self.auth():
                self.answer(200, dashboard(), "text/html")
        else:
            self.answer(404)

    def do_POST(self):
        admin = self.server.is_admin and self.path == "/"
        if admin and not self.auth():
            return
        if not admin and (self.server.is_admin or self.path not in ("/activate", "/trial")):
            self.answer(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4096:
                raise ValueError()
            self.connection.settimeout(8)
            raw = self.rfile.read(size).decode()
            if admin:
                code = manage(parse_qs(raw, max_num_fields=12))
                if code:
                    self.answer(200, dashboard(code), "text/html")
                else:
                    self.answer(303, Location="/")
            else:
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError()
                self.answer(200, json.dumps(enroll(payload, self.client_address[0], self.path == "/trial")), "application/json")
        except (ValueError, OSError, sqlite3.Error):
            self.answer(400, "操作未完成，请检查参数或配对码。")


class Server(ThreadingHTTPServer):
    request_queue_size = 32
    tls = None

    def __init__(self, *args):
        self.workers = threading.BoundedSemaphore(32)
        super().__init__(*args)

    def process_request(self, request, address):
        if self.workers.acquire(blocking=False):
            try:
                super().process_request(request, address)
            except Exception:
                self.workers.release()
                raise
        else:
            self.shutdown_request(request)

    def process_request_thread(self, request, address):
        try:
            if self.tls is None:
                super().process_request_thread(request, address)
            elif request.recv(1, socket.MSG_PEEK) == b"S":
                with socket.create_connection(("127.0.0.1", DEVICE_SSH_PORT), timeout=5) as upstream:
                    relay_ssh(request, upstream)
            else:
                wrapped = self.tls.wrap_socket(request, server_side=True)
                super().process_request_thread(wrapped, address)
        except OSError:
            pass
        finally:
            request.close()
            self.workers.release()

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(8)
        return sock, address


def relay_ssh(client, upstream):
    peers = {client: upstream, upstream: client}
    for peer in peers:
        peer.settimeout(15)
    while peers:
        ready, _, _ = select.select(list(peers), [], [], 65)
        if not ready:
            return
        for origin in ready:
            target = peers[origin]
            data = origin.recv(65536)
            if data:
                target.sendall(data)
            else:
                target.shutdown(socket.SHUT_WR)
                del peers[origin]


def serve():
    global HOST, PORT, ADMIN_AUTH, CSRF
    HOST = sys.argv[2]
    PORT = int(sys.argv[3])
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", HOST):
        raise ValueError("Invalid advertised hostname")
    cert = HOME / "pairing.crt"
    password = (HOME / "admin-password").read_text().strip()
    if len(password) < 24:
        raise ValueError("Admin password is missing or too short")
    ADMIN_AUTH = b"Basic " + base64.b64encode(("admin:" + password).encode())
    CSRF = secrets.token_hex(32)
    setup()
    admin = Server(("127.0.0.1", ADMIN_PORT), Handler)
    admin.is_admin = True
    enrollment = Server(("0.0.0.0", PORT), Handler)
    enrollment.is_admin = False
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, HOME / "pairing.key")
    # Do the TLS handshake in the request worker, not the accept loop.
    enrollment.tls = context
    threading.Thread(target=admin.serve_forever, daemon=True).start()
    enrollment.serve_forever()


def ssh(key_id):
    if not re.fullmatch(r"[a-f0-9]{32}", key_id):
        return 1
    action = os.environ.get("SSH_ORIGINAL_COMMAND")
    with database() as db:
        device = access_device(db, key_id)
        if device is None:
            return 1
        current = access_state(device)
        if action == "squad-status":
            expires = device["expires"]
            print(json.dumps({"state": current, "expiresAt": None if expires is None else expires * 1000}))
            return 0
        if action in ("squad-subscription", "squad-subscribe-month", "squad-subscribe-year"):
            # The subscription helper owns its transaction and does not launch the agent.
            term = {"squad-subscribe-month": "month", "squad-subscribe-year": "year"}.get(action)
            try:
                print(json.dumps(subscription(device, term)))
                return 0
            except ValueError as error:
                print(str(error), file=sys.stderr)
                return 1
        if current != "active" or action not in ("squad-agent", "squad-quota"):
            print("Squad device authorization denied: " + current, file=sys.stderr)
            return 1
        db.execute("UPDATE devices SET seen=? WHERE id=?", (int(time.time()), key_id))
    args = ["app-server", "--stdio"] if action == "squad-agent" else ["squad-quota"]
    agent = action == "squad-agent"
    child = subprocess.Popen(["/usr/bin/sudo", "-n", "-u", USER, PROGRAM, *args],
                             stdin=subprocess.PIPE if agent else None, stdout=subprocess.PIPE if agent else None)
    if agent:
        bridge(child, key_id)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, lambda *_: child.terminate())
    limit = time.monotonic() + (1800 if action == "squad-agent" else 15)
    try:
        while time.monotonic() < limit:
            try:
                return child.wait(1)
            except subprocess.TimeoutExpired:
                with database() as db:
                    if db.execute("SELECT stop FROM devices WHERE id=?", (key_id,)).fetchone()["stop"]:
                        break
        return 1
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(4)
            except subprocess.TimeoutExpired:
                child.kill()


def bridge(child, key_id):
    """Allow one turn over each SSH stream and scope resume handles to this device."""
    allowed_thread = None
    opening = None
    bound = False
    started = False
    waiting = set()
    lock = threading.Lock()

    def check_access():
        with database() as db:
            if access_state(access_device(db, key_id)) != "active":
                raise ValueError("device authorization denied")

    def outgoing():
        nonlocal allowed_thread
        try:
            for raw in iter(child.stdout.readline, b""):
                message = json.loads(raw)
                with lock:
                    if message.get("id") == opening and opening is not None and "result" in message:
                        thread = message["result"]["thread"]["id"]
                        with database() as db:
                            db.execute("INSERT OR IGNORE INTO threads VALUES (?,?)", (thread, key_id))
                        allowed_thread = thread
                    if message.get("method") == "item/tool/call" and "id" in message:
                        waiting.add(message["id"])
                sys.stdout.buffer.write(raw)
                sys.stdout.buffer.flush()
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
            child.terminate()

    def incoming():
        nonlocal opening, bound, started
        initialized = False
        try:
            while raw := sys.stdin.buffer.readline(4 * 1024 * 1024):
                if not raw.endswith(b"\n"):
                    break
                message = json.loads(raw)
                method = message.get("method")
                request_id = message.get("id")
                params = message.get("params", {})
                with lock:
                    if method is None and request_id in waiting:
                        waiting.remove(request_id)
                    elif method == "initialize" and not initialized and type(request_id) is int:
                        initialized = True
                        message["params"] = {"clientInfo": {"name": "squad_gateway", "version": "1"},
                                             "capabilities": {"experimentalApi": True}}
                    elif method == "initialized" and initialized and request_id is None and not bound:
                        message["params"] = {}
                    elif method in ("thread/start", "thread/resume") and initialized and not bound and type(request_id) is int:
                        check_access()
                        bound = True
                        opening = request_id
                        config = {"approvalPolicy": "on-request", "sandbox": "read-only", "environments": [],
                                  "dynamicTools": params.get("dynamicTools", []),
                                  "developerInstructions": params.get("developerInstructions", "")}
                        if method == "thread/resume":
                            thread = params.get("threadId")
                            with database() as db:
                                if not isinstance(thread, str) or not db.execute(
                                    "SELECT 1 FROM threads WHERE id=? AND device=?", (thread, key_id)).fetchone():
                                    raise ValueError("thread not found")
                            config["threadId"] = thread
                        message["params"] = config
                    elif method == "turn/start" and not started and allowed_thread and params.get("threadId") == allowed_thread:
                        check_access()
                        started = True
                        message["params"] = {key: params[key] for key in ("threadId", "input", "effort") if key in params}
                    elif method == "turn/interrupt" and started and params.get("threadId") == allowed_thread:
                        message["params"] = {"threadId": allowed_thread, "turnId": params.get("turnId")}
                    else:
                        raise ValueError("command not permitted")
                child.stdin.write(json.dumps(message).encode() + b"\n")
                child.stdin.flush()
        except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError, sqlite3.Error) as error:
            # Only fixed error text goes back to the device. Never echo its request.
            detail = str(error) if str(error) in ("thread not found", "device authorization denied") else "command not permitted"
            print("Squad gateway: " + detail, file=sys.stderr, flush=True)
        finally:
            child.stdin.close()

    threading.Thread(target=outgoing, daemon=True).start()
    threading.Thread(target=incoming, daemon=True).start()


if __name__ == "__main__":
    os.umask(0o077)
    if sys.argv[1:2] == ["serve"]:
        serve()
    elif len(sys.argv) == 3 and sys.argv[1] == "ssh":
        sys.exit(ssh(sys.argv[2]))
    else:
        sys.exit(1)
