---
name: share-app
description: Show a web application that runs in this box to the person you work for, through a public Microsoft Dev Tunnels link. Use when asked to share, demo or let them try the running app, or to give them a link to it.
---

# Sharing a running web application

The person you work for cannot reach this box's ports. A dev tunnel gives
a port in this box a public HTTPS URL. Anyone who knows the URL can open
it, and the URL has a random part that nobody can guess. The person
clicks the link and sees the application. There is no login and no
password to pass on.

## Before you start

- `DEVTUNNELS_TOKEN` is set in every box. If the API answers `401`, nobody
  has logged in to Dev Tunnels on the settings page, or the login has
  expired. Stop and say so; sharing is not possible until then.
- The application must listen on a port in this box. `127.0.0.1` is enough;
  it does not have to listen on all interfaces.
- The token in `DEVTUNNELS_TOKEN` is a placeholder. The egress proxy swaps
  in the real one. Use it only as shown below, and never print it.
- The service has a global API host and one per region. The global host
  learns about a new tunnel minutes late, so after the first step every
  command names the tunnel's region.

## Steps

1. Create a tunnel with one port that anyone may connect to. Replace
   `3000` with the application's port. The answer holds the tunnel's id,
   its region, a host token for this tunnel, and the URL.

   ```sh
   curl -fsS -X POST \
     'https://global.rel.tunnels.api.visualstudio.com/api/v1/tunnels?tokenScopes=host&includePorts=true' \
     -H "Authorization: github $DEVTUNNELS_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"ports":[{"portNumber":3000,"protocol":"http"}],"accessControl":{"entries":[{"type":"Anonymous","subjects":[],"scopes":["connect"]}]}}' \
     > "$TMPDIR/share-app-tunnel.json"
   tunnel=$(jq -r '"\(.tunnelId).\(.clusterId)"' "$TMPDIR/share-app-tunnel.json")
   api="https://$(jq -r .clusterId "$TMPDIR/share-app-tunnel.json").rel.tunnels.api.visualstudio.com/api/v1"
   jq -r 'first(.ports[0].portForwardingUris[] | select(test("\\.ms:[0-9]+/") | not))' \
     "$TMPDIR/share-app-tunnel.json"
   ```

   The service also lists a URL with the port number after the host name.
   Do not use that one: it needs the port open on the visitor's network.
   The command above picks the URL on the standard HTTPS port.

2. Host the tunnel as a background command, so it keeps running while the
   turn ends. The host token works for this one tunnel only and lasts 24
   hours.

   ```sh
   devtunnel host "$tunnel" \
     --access-token "$(jq -r .accessTokens.host "$TMPDIR/share-app-tunnel.json")"
   ```

   It is ready when it prints `Ready to accept connections`.

3. Tell the person the URL from step 1. Say that the first visit may show
   a warning page about dev tunnels, where they click "Continue".

4. When they say they are done, or when you finish the task, stop the
   `devtunnel` process and delete the tunnel. A tunnel left behind stays
   reachable and counts against the account's limit of ten.

   ```sh
   curl -fsS -X DELETE "$api/tunnels/${tunnel%%.*}" \
     -H "Authorization: github $DEVTUNNELS_TOKEN"
   ```

## Problems and fixes

- `devtunnel host` says `Login required`: it was given the tunnel id
  without the region, or the tunnel does not exist. Use the
  `tunnelId.clusterId` form from step 1.
- Creating a tunnel fails because the account has too many: list them on
  each region's host, for example
  `curl -fsS https://euw.rel.tunnels.api.visualstudio.com/api/v1/tunnels -H "Authorization: github $DEVTUNNELS_TOKEN"`,
  and delete the ones no task uses any more. The regions are listed by
  `devtunnel clusters`.
- The page loads, but the application redirects to `localhost` or rejects
  the request: development servers such as Vite check the `Host` header.
  Add the tunnel's host name to the server's allowed hosts setting.
- The free service allows 5 GB of traffic per month. A long demo of a page
  that polls or streams can use that up.
