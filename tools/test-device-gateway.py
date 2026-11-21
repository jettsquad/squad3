import base64
import importlib.util
import tempfile
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("gateway", Path(__file__).with_name("device-gateway.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class ActivationTest(unittest.TestCase):
    def test_guest_subscription_requires_review_and_approval_extends_once(self):
        with tempfile.TemporaryDirectory() as location:
            gateway.HOME = Path(location)
            gateway.HOST = "test.example"
            gateway.PORT = 18443
            gateway.CSRF = "test"
            (gateway.HOME / ".ssh").mkdir()
            (gateway.HOME / "ssh-host.pub").write_text("ssh-ed25519 mock")
            gateway.setup()
            key = base64.b64encode(b"\0\0\0\x0bssh-ed25519\0\0\0 " + bytes(32)).decode()
            payload = {"name": "Trial PC", "publicKey": "ssh-ed25519 " + key}
            identity = gateway.enroll(payload, "127.0.0.1", trial=True)["deviceId"]
            self.assertEqual(gateway.enroll(payload, "127.0.0.2", trial=True)["deviceId"], identity)
            with gateway.database() as db:
                device = gateway.access_device(db, identity)
            before = device["expires"] * 1000
            self.assertEqual(gateway.access_state(device), "active")
            pending = gateway.subscription(device, "month")
            self.assertEqual(pending["request"]["status"], "pending")
            self.assertEqual(pending["expiresAt"], before)
            self.assertEqual(gateway.subscription(device, "month"), pending)
            with self.assertRaises(ValueError):
                gateway.subscription(device, "year")
            with gateway.database() as db:
                request_id = db.execute("SELECT id FROM subscriptions").fetchone()["id"]
            approval = {"csrf": ["test"], "request": [request_id], "op": ["approve-subscription"]}
            gateway.manage(approval)
            result = gateway.subscription(device)
            self.assertEqual(result["request"]["status"], "approved")
            self.assertIn((result["expiresAt"] - before) // 86400000, (28, 29, 30, 31))
            with self.assertRaises(ValueError):
                gateway.manage(approval)
            expired = int(time.time()) - 2000
            with gateway.database() as db:
                db.execute("UPDATE devices SET expires=? WHERE id=?", (expired, identity))
            annual = gateway.subscription(device, "year")
            self.assertEqual(annual["state"], "expired")
            self.assertEqual(annual["request"]["status"], "pending")
            with gateway.database() as db:
                annual_id = db.execute("SELECT id FROM subscriptions WHERE status='pending'").fetchone()["id"]
            gateway.manage({"csrf": ["test"], "request": [annual_id], "op": ["reject-subscription"]})
            rejected = gateway.subscription(device)
            self.assertEqual(rejected["request"]["status"], "rejected")
            self.assertEqual(rejected["expiresAt"], expired * 1000)

    def test_trial_retry_and_admin_changes(self):
        with tempfile.TemporaryDirectory() as location:
            gateway.HOME = Path(location)
            gateway.HOST = "test.example"
            gateway.PORT = 18443
            gateway.CSRF = "test"
            (gateway.HOME / ".ssh").mkdir()
            (gateway.HOME / "ssh-host.pub").write_text("ssh-ed25519 mock")
            gateway.setup()
            key = base64.b64encode(b"\0\0\0\x0bssh-ed25519\0\0\0 " + bytes(range(32))).decode()
            credential = gateway.manage({"csrf": ["test"], "op": ["create-account"], "account": ["tester"]})
            password = credential.splitlines()[1].split("：")[1]
            payload = {"account": "tester", "password": password, "name": "Test PC", "publicKey": "ssh-ed25519 " + key}
            before = int(time.time())
            with self.assertRaises(ValueError):
                gateway.enroll({**payload, "password": "x" * 32}, "127.0.0.1")
            result = gateway.enroll(payload, "127.0.0.1")
            identity = result["deviceId"]

            def device():
                with gateway.database() as db:
                    return gateway.access_device(db, identity)

            def manage(operation, days="0"):
                gateway.manage({"csrf": ["test"], "id": [identity], "op": [operation], "days": [days]})

            self.assertIn(device()["expires"] - before, (864000, 864001))
            gateway.manage({"csrf": ["test"], "op": ["disable-account"], "account": ["tester"]})
            self.assertEqual(gateway.access_state(device()), "paused")
            with self.assertRaises(ValueError):
                gateway.enroll(payload, "127.0.0.2")
            gateway.manage({"csrf": ["test"], "op": ["enable-account"], "account": ["tester"]})
            manage("set-duration", "2")
            shortened = device()["expires"]
            self.assertLess(shortened, before + 3 * 86400)
            self.assertEqual(gateway.enroll(payload, "127.0.0.2"), result)
            self.assertEqual(device()["expires"], shortened)
            manage("renew", "1")
            self.assertEqual(device()["expires"], shortened + 86400)
            manage("set-duration")
            self.assertIsNone(device()["expires"])
            manage("pause")
            self.assertEqual(gateway.state(device()), "paused")
            manage("revoke")
            self.assertEqual(gateway.enroll(payload, "127.0.0.1"), result)
            self.assertEqual(gateway.state(device()), "revoked")


if __name__ == "__main__":
    unittest.main()
