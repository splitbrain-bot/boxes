# Users

By default, Boxes runs in single user mode, in which one user owns all boxes and all settings. In multi-user mode,
several people, for example colleagues or friends, use one deployment.

Boxes has no login of its own. The reverse proxy in front of Boxes authenticates each user, and it sends the username to
the orchestrator in an HTTP header.

## Turn on multi-user mode

To turn on multi-user mode, set `AUTH_USER_HEADER` to the name of the header that holds the username, for example
`Remote-User`. See [Environment variables](environment.md).

The orchestrator removes the spaces around the username and changes the username to lowercase. As a result, `Alice`
and `alice` are the same user. A username can have up to 200 characters.

The box list shows the name of the current user next to the logo, so each person can see which account they use. To log
out, the user logs out at the reverse proxy.

Boxes has no admin role. The environment variables are the only configuration for the whole deployment, and they apply
to all users.

## Requirements of the reverse proxy

The header is safe only when the reverse proxy meets the requirements below:

- Nobody can connect to the orchestrator without the reverse proxy. The shipped Compose file publishes the orchestrator
  only on the loopback address. See [Docker Compose setup](compose.md#host-access).
- Each route of the reverse proxy to the orchestrator authenticates the user, and it does not forward a username header
  that the browser of the user sent.
- The reverse proxy sends the header also on the WebSocket upgrades under `/ws`.

## Requests without a username

Requests without a username are answered with the status 401 by the orchestrator and the browser shows an error page.

The orchestrator does answer `/healthz`, `/readyz` and `/api/boot` without a username, so a health check can use them.

## Data of a user

Each user has their own [boxes](boxes.md), and with each box its threads, permission requests and tunnels. Each user
also has their own [credentials](credentials.md), API keys, [agent sets](agent-sets.md), settings and
[push subscriptions](notifications.md). A box always uses the credentials, the agent sets and the settings of its owner.

A user sees only their own boxes. For a box of a different user, the API answers 404, as for a box that does not exist.
As a result, a user cannot find the box ids of other users. The orchestrator also refuses the WebSocket upgrades for a
box of a different user.

## Change from single user mode to multi-user mode

In single user mode, all data has the empty user as its owner. When you set `AUTH_USER_HEADER` on an existing
deployment, the first request with a username gets all data of the empty user. The orchestrator changes the owner in one
transaction, and it writes a log entry with the username. When two users send their first request at the same time,
only one of the two users gets the data.

Only requests to the dashboard and to the REST API get the data. Requests to `/healthz`, `/readyz` and `/api/boot` do
not get the data, so a health check of the reverse proxy or of a monitoring tool cannot take it.

## Change back to single user mode

When you remove `AUTH_USER_HEADER`, the user sees the boxes of all users again. Each box keeps the credentials, the
agent sets and the git identity of its owner. The settings page shows only the data of the empty user, so the
credentials, agent sets and settings of the former users do not show on the settings page, and the user cannot change
them.
