# Test Runner — Autonomous App Testing

Signs up, verifies, and logs in up to 1,000 test users on an app, reading verification
codes automatically from Gmail (successeverydayww@gmail.com +aliases).

## Usage
```
python3 .agents/skills/test-runner/scripts/run.py \
  --app-name "AppName" \
  --count 50 \
  --signup-url "https://.../api/signup" \
  --login-url "https://.../api/login" \
  --verify-url "https://.../api/verify"   # optional
```

Requires $GMAIL_ACCESS_TOKEN in env (use get_connector_token gmail first).
Results saved to workspace: results/<app>-<timestamp>.csv + .json + summary.

For Base44 apps, prefer the app's own API endpoints or ask the owner to expose
a test-mode signup. Report all credentials back to the owner after every run.
