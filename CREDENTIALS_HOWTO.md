# CREDENTIALS ANNEX — encrypted

`BEACON_CREDENTIALS_ANNEX.md.enc` holds the keys, logins and service details for everything we
run. It is encrypted with AES-256 (PBKDF2) because this repository is public.

Samuel holds the passphrase. To read the annex:

    openssl enc -d -aes-256-cbc -pbkdf2 -in BEACON_CREDENTIALS_ANNEX.md.enc -out annex.md

Type the passphrase when prompted. Never commit the decrypted `annex.md`; it is gitignored.

If the passphrase is ever lost, the annex is unreadable by anyone, including me, and we rebuild
the credentials from the live accounts instead. That is the intended trade-off: the beacon is
useless to a stranger even if the repo is copied.

## Second encrypted payload

`sensitive_scripts.tar.gz.enc` holds the scripts that have credentials baked into them by
design: `build_credentials_pdf.py` (the master key list), and the three promo capture scripts
that log into a test student account. Same passphrase. To unpack:

    openssl enc -d -aes-256-cbc -pbkdf2 -in sensitive_scripts.tar.gz.enc -out /tmp/sens.tar.gz
    tar -xzf /tmp/sens.tar.gz -C /tmp/sens

Keep the unpacked copies local. Never commit them; never paste them into a chat.
