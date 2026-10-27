#!/usr/bin/env python3
"""Premium User — Autonomous App Test Runner (up to 1,000 users per run)."""
import argparse, csv, json, os, random, re, string, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

BASE_EMAIL = "successeverydayww@gmail.com"

def gen_password(length=14):
    chars = string.ascii_letters + string.digits + "!@#$%"
    while True:
        pwd = "".join(random.choice(chars) for _ in range(length))
        if any(c.isupper() for c in pwd) and any(c.isdigit() for c in pwd) and any(c in "!@#$%" for c in pwd):
            return pwd

def alias_email(i):
    return f"successeverydayww+test{i}@gmail.com"

def http_json(url, payload, method="POST"):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode()
            try: return r.status, json.loads(body)
            except Exception: return r.status, {"raw": body}
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:
        return 0, {"error": str(e)}

def gmail_query(q):
    token = os.environ.get("GMAIL_ACCESS_TOKEN")
    if not token: return []
    url = "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=" + urllib.parse.quote(q)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return [m["id"] for m in json.loads(r.read().decode()).get("messages", [])]
    except Exception:
        return []

def gmail_message(msg_id):
    token = os.environ.get("GMAIL_ACCESS_TOKEN")
    url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}?format=full"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}

def fetch_verification_code(email_addr, wait_seconds=180, poll=10):
    """Poll Gmail for the newest verification code email sent to email_addr."""
    token = os.environ.get("GMAIL_ACCESS_TOKEN")
    if not token:
        return None, "no gmail token"
    import urllib.parse
    deadline = time.time() + wait_seconds
    seen = set()
    while time.time() < deadline:
        ids = gmail_query(f"to:{email_addr} newer_than:1d")
        for mid in ids:
            if mid in seen: continue
            seen.add(mid)
            msg = gmail_message(mid)
            body = msg.get("snippet", "")
            if not body:
                parts = msg.get("payload", {}).get("parts", [])
                for p in parts:
                    data = p.get("body", {}).get("data")
                    if data:
                        import base64
                        body += base64.urlsafe_b64decode(data).decode("utf-8", "ignore")
            m = re.search(r"\b(\d{4,8})\b", body)
            if m:
                return m.group(1), "ok"
        time.sleep(poll)
    return None, "timeout"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-name", required=True)
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--signup-url")
    ap.add_argument("--login-url")
    ap.add_argument("--verify-url")
    ap.add_argument("--email-field", default="email")
    ap.add_argument("--password-field", default="password")
    ap.add_argument("--code-field", default="code")
    ap.add_argument("--start-index", type=int, default=1, help="avoid alias collisions across runs")
    args = ap.parse_args()

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    outdir = os.path.join("results", f"{args.app_name}-{ts}")
    os.makedirs(outdir, exist_ok=True)
    rows = []
    print(f"Starting run: {args.count} users on {args.app_name}")
    for i in range(args.start_index, args.start_index + args.count):
        email = alias_email(i)
        pwd = gen_password()
        row = {"index": i, "email": email, "password": pwd,
               "signup": "skipped", "code": "", "login": "skipped"}
        if args.signup_url:
            payload = {args.email_field: email, args.password_field: pwd}
            st, resp = http_json(args.signup_url, payload)
            row["signup"] = f"{st}"
            if st in (200, 201) and args.verify_url:
                code, info = fetch_verification_code(email)
                if code:
                    row["code"] = code
                    vst, _ = http_json(args.verify_url, {args.email_field: email, args.code_field: code})
                    row["signup"] += f"/verify:{vst}"
                else:
                    row["signup"] += f"/verify:FAILED({info})"
        if args.login_url:
            st, resp = http_json(args.login_url, {args.email_field: email, args.password_field: pwd})
            row["login"] = f"{st}"
        rows.append(row)
        print(f"[{i-args.start_index+1}/{args.count}] {email} signup={row['signup']} login={row['login']}")

    csv_path = os.path.join(outdir, "accounts.csv")
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys()); w.writeheader(); w.writerows(rows)
    with open(os.path.join(outdir, "accounts.json"), "w") as f:
        json.dump(rows, f, indent=2)
    ok = sum(1 for r in rows if r["login"].startswith(("200", "201")))
    print(f"REPORT|app={args.app_name}|total={len(rows)}|login_ok={ok}|file={csv_path}")

if __name__ == "__main__":
    import urllib.parse
    main()
