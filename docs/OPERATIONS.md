# Local Operations

## First launch

Open PowerShell in the repository root and run:

    npm test
    npm run check
    npm start

The first start creates a random operator token, stores only its SHA-256 hash in the SQLite settings table, and prints the plaintext token once. Copy it into a password manager. Do not put it in source control or share it in chat.

The server binds to 127.0.0.1:4317 by default.

## Subsequent launches

Set the token in the current PowerShell session before starting:

    $env:RAYA_CC_OPERATOR_TOKEN = 'PASTE_THE_SAVED_TOKEN_HERE'
    npm start

If the database already has an operator-token hash and the environment variable is absent or incorrect, startup fails closed.

## Rotate the operator token

1. Stop the running server.
2. Run:

       node src/rotate-operator-token.js

3. Save the new token from stdout in a password manager.
4. Set RAYA_CC_OPERATOR_TOKEN to the new token in PowerShell.
5. Restart with npm start.

The rotation command changes the database hash immediately. The old server process retains its in-memory token until stopped, so stop it before rotating.

## Configuration

- RAYA_CC_PORT ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â TCP port, default 4317.
- RAYA_CC_DATABASE ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â SQLite file path, default .data/control-center.sqlite.
- RAYA_CC_OPERATOR_TOKEN ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â operator token, minimum 32 characters.

The API is local-only. Do not expose it through a reverse proxy, tunnel, port forward, or wildcard bind. Remote ingress is explicitly outside the MVP.

## Data and backups

The database is application state and contains participant metadata, task payloads, leases, operator credential hash, and event history. Protect it as private data.

For a consistent simple backup, stop the server, copy the database file, then restart. WAL sidecar files may exist while the server is running; do not copy only the main database file during active writes.

## API smoke check

With the server running:

    Invoke-RestMethod http://127.0.0.1:4317/control/v1/health

Expected response:

    status api
    ------ ---
    ok     control/v1
