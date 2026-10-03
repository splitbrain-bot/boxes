---
name: share-app
description: Show a web application that runs in this box to the person you work for, through a private Microsoft Dev Tunnels link that only their GitHub account can open. Use when asked to share, demo or let them try the running app, or to give them a link to it.
---

# Sharing a running web application

The person you work for cannot reach this box's ports. A dev tunnel gives
a port in this box a public HTTPS URL. The tunnel is private: only the
GitHub account that the deployment logged in with can open it. The person
clicks the link, signs in with GitHub once, and sees the application. There
is no password to pass on.

## Before you start

- `DEVTUNNELS_TOKEN` is set in every box. If the API answers `401`, nobody
  has logged in to Dev Tunnels on the settings page, or the login has
  expired. Stop and say so; sharing is not possible until then.
- The application must listen on a port in this box. `127.0.0.1` is enough;
  it does not have to listen on all interfaces.
- The token in `DEVTUNNELS_TOKEN` is a placeholder. The egress proxy swaps
  in the real one. Use it only as shown below, and never print it.

## Steps

1. Create a tunnel with one port. Replace `3000` with the application's
   port. The answer holds the tunnel's id, a host token for this tunnel, and
   the URL.

   ```sh
   api=https://global.rel.tunnels.api.visualstudio.com/api/v1
   curl -fsS -X POST "$api/tunnels?tokenScopes=host&includePorts=true" \
     -H "Authorization: github $DEVTUNNELS_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"ports":[{"portNumber":3000,"protocol":"http"}]}' \
     > "$TMPDIR/share-app-tunnel.json"
   jq -r '.tunnelId, .ports[0].portForwardingUris[0]' "$TMPDIR/share-app-tunnel.json"
   ```

2. Host the tunnel as a background command, so it keeps running while the
   turn ends. The host token works for this one tunnel only and lasts 24
   hours.

   ```sh
   devtunnel host "$(jq -r .tunnelId "$TMPDIR/share-app-tunnel.json")" \
     --access-token "$(jq -r .accessTokens.host "$TMPDIR/share-app-tunnel.json")"
   ```

   It is ready when it prints `Ready to accept connections`.

3. Tell the person the URL from step 1. Say that the first visit asks them
   to sign in with GitHub, with the account that is logged in on the
   settings page, and may show a warning page about dev tunnels, where they
   click "Continue".

4. When they say they are done, or when you finish the task, stop the
   `devtunnel` process and delete the tunnel. A tunnel left behind counts
   against the account's limit of ten.

   ```sh
   curl -fsS -X DELETE \
     "$api/tunnels/$(jq -r .tunnelId "$TMPDIR/share-app-tunnel.json")" \
     -H "Authorization: github $DEVTUNNELS_TOKEN"
   ```

## Problems and fixes

- Creating a tunnel fails because the account has too many: list them with
  `curl -fsS "$api/tunnels" -H "Authorization: github $DEVTUNNELS_TOKEN"`,
  and delete the ones no task uses any more.
- The page loads, but the application redirects to `localhost` or rejects
  the request: development servers such as Vite check the `Host` header.
  Add the tunnel's host name to the server's allowed hosts setting.
- The free service allows 5 GB of traffic per month. A long demo of a page
  that polls or streams can use that up.
