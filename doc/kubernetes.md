# Kubernetes setup

Boxes can run in a Kubernetes cluster in place of [Docker Compose](compose.md). The orchestrator then runs each box as
a pod in its own namespace. The manifests in `k8s/` install the orchestrator, the [egress proxy](egress.md) and their
policies in the namespace `boxes`:

```sh
kubectl apply -k k8s/
```

## Requirements

The cluster must have:

- Kubernetes 1.30 or later. The [file service](files.md) closes its stdin, and only the exec protocol
  `v5.channel.k8s.io` can send that.
- A network plugin that enforces `NetworkPolicy` for ingress and egress. Without it, the policies have no effect and
  the boxes are not isolated, and no part of Boxes reports an error.
- A default storage class. Its volumes must support `fsGroup`, or they must be writable for all users, so that the agent
  can write in the directories that the kubelet makes in a new volume.
- The kubelet setting `podPidsLimit` on each node, for example 512, the limit of a Docker box. A pod has no pids limit
  of its own, so `BOX_PIDS_LIMIT` has no effect (#127).
- CoreDNS with the label `k8s-app=kube-dns` in `kube-system`. Only the login pods use DNS.

## Resources

| Resource | Purpose |
| --- | --- |
| Namespace `boxes` | Holds all of Boxes. The `restricted` Pod Security Standard applies to each pod in it. |
| Deployment `boxes-orchestrator` | The orchestrator, as one replica that runs as uid 1000 with a read-only root filesystem. |
| Role `boxes-orchestrator` | Lets the orchestrator manage pods, claims and network policies, exec into pods, and read the proxy Service. It has no rights outside the namespace. |
| Claim `boxes-orchestrator-data` | The database, the generated keys and the skill repositories. |
| Deployment and Service `boxes-egress-proxy` | The egress proxy. |
| Ingress `boxes-orchestrator` | The way in from outside the cluster. |

Optional [settings](environment.md) go into a ConfigMap `boxes-settings` in the namespace. The orchestrator reads it at
its start.

## Boxes as pods

The orchestrator makes these objects for each box:

| Object | Name | Contents |
| --- | --- | --- |
| Pod | `box-<id>` | The box. The orchestrator makes it at each start and deletes it at each stop. |
| Claim | `box-<id>` | The workspace, the home and the Nix store, in the directories `workspace`, `home` and `nix` of one volume. Its size is `BOX_STORAGE_SIZE`. |
| Network policy | `box-<id>` | Allows connections to the egress proxy pods on the proxy port, and nothing else. |

The proxy URL in a box names the cluster IP of the proxy Service, so the processes in a box need no DNS. The
orchestrator reads the Service at its start, and it must be started again when the Service gets a new cluster IP.

A login runs in a pod `login-<random>` with its home in memory. The network policy `boxes-login` lets login pods connect
to the internet and to the cluster DNS, but not to private address ranges.

The kubelet pulls the box image when a pod starts. With the default `BOX_IMAGE_PULL_POLICY=Always`, each start gets the
current image of the tag, and a box start needs the registry. Boxes started at different times can thus run different
images. The kubelet also removes old images.

The memory and CPU limits of a box are `BOX_MEM_LIMIT` and `BOX_CPUS`. The scheduler reserves only `BOX_MEM_REQUEST` and
`BOX_CPU_REQUEST`, because most boxes are idle most of the time. The kubelet can evict a box pod that uses more than its
request when its node runs out of memory. The box is then stopped, and at its next start the scheduler puts the new pod
on a node with free memory.

## Access

The orchestrator has no authentication of its own. The Ingress in `k8s/ingress.yaml` has a placeholder for the
authentication of the ingress controller, and it is not safe until you fill it in. The network policy
`boxes-orchestrator` lets only the namespace `ingress-nginx` connect to the orchestrator. Change it to the namespace of
your ingress controller. For multi-user mode, the authentication of the ingress controller must send the username in a
header. See [Users](users.md).

Without an Ingress, a port forward connects to the orchestrator:

```sh
kubectl -n boxes port-forward service/boxes-orchestrator 3000
```

## Limits

- When a node fails, its box pods stay in `Terminating`, because the cluster does not release their volumes. The box
  cannot start on another node until an operator sets the `node.kubernetes.io/out-of-service` taint on the node.
- An exec through the API server can end after a time without traffic, for example after 4 hours with containerd. The
  adapters, the [terminal](terminal.md) and the file service then connect again. A turn that waits longer than that for
  a permission is lost.
- The image footer shows the image of the box pod that started last, and no build time or size for the images.
