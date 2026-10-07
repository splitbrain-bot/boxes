# Glossary

**Deployment**

One running installation of Boxes. It consists of the orchestrator, the egress proxy, persistent data, and any boxes it
creates.

**[Orchestrator](orchestrator.md)**

The main Boxes service. It serves the dashboard and API, stores deployment state, and creates, starts, and stops boxes.

**Dashboard**

The web interface served by the orchestrator. It is where users manage boxes, threads, credentials, settings, and agent
configuration.

**[Box](boxes.md)**

An isolated Docker container in which an agent works. A box has its own workspace, persistent home directory, resource
limits, and private network.

**[Workspace](storage.md)**

The files an agent works on in a box. Workspaces persist when a box stops and are stored in the deployment's data
volume.

**[Agent set](agent-sets.md)**

A named collection of agent instructions, skills, and commands. Boxes copies the selected set into each box when it
starts.

**Harness**

An agent integration available in a box, such as Claude or Codex. A harness is what actually runs the agent and talks to
the LLM.

**[Thread](threads.md)**

A single conversation with an agent in a box. A thread uses one harness and keeps its conversation state while the box
is available.

**[Session](acp.md)**

A conversation state inside a harness, accessed through ACP. Boxes calls it a thread.

**[Adapter](acp.md)**

The process in a box that provides ACP access to a harness. The dashboard reaches it through the ACP gateway.

**[Tunnel](skills.md)**

A public HTTPS link to a port in a box, used to share a running application. Boxes creates tunnels with [Microsoft Dev
Tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/overview).

**[Egress proxy](egress.md)**

The service that provides a box's only outbound network path. It enforces network policy and replaces a credential
placeholder with its stored credential only for the matching service.
