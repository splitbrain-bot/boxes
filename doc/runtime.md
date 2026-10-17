# Runtime

The runtime is the part of the [orchestrator](orchestrator.md) that runs the [boxes](boxes.md), keeps their storage and
isolates them. The rest of the orchestrator reaches a box only through the `Runtime` interface in
`orchestrator/src/runtime/runtime.ts`, and it identifies each box by its id. There are two runtimes: `DockerRuntime` in
`orchestrator/src/runtime/docker.ts`, and `KubernetesRuntime` in `orchestrator/src/runtime/kubernetes.ts` (see
[Kubernetes setup](kubernetes.md)).

## Parts of the interface

| Area | Methods | Docker | Kubernetes |
| --- | --- | --- | --- |
| Storage | `createStorage`, `missingStorage`, `removeStorage` | Three directories in the data volume, bind mounted into the container. See [storage](storage.md). | The claim `box-<id>`, mounted three times with a `subPath`. |
| Lifecycle | `ensure`, `start`, `stop`, `remove`, `state` | The container `box-<id>`. | The pod `box-<id>`, made at each start and deleted at each stop. |
| Isolation | `ensure`, `isolated`, `proxyUrl` | The internal network `bn-<id>`, with the [egress proxy](egress.md) attached under the alias `proxy`. | The network policy `box-<id>`, and the cluster IP of the proxy Service. |
| Processes | `run`, `spawn` | A Docker exec as `BOX_UID`. | An exec through the API server, under `env` for the directory and the variables. |
| Box image | `imageOf`, `ensureImage`, `refreshImage` | Pull `BOX_IMAGE`, compare the image ids, and remove the old images. | Nothing: the kubelet pulls with `BOX_IMAGE_PULL_POLICY`. |
| Inventory | `inventory`, `removeObject` | The containers and networks with the label `boxes.box`, the box directories, and the containers with the label `boxes.login`. | The pods, policies and claims with the label `boxes.box`, and the pods with the label `boxes.login`. |
| Logins | `startLogin` | A container on the default bridge network, with its home on a tmpfs. | A pod with its home in memory, under the network policy `boxes-login`. |
| Facts | `prepare`, `details`, `health`, `deploymentImages` | The host path of the data volume, the container, the network and the image ids. | The proxy Service, the pod, the node, the claim and the image ids. |

The runtime knows nothing about threads, reviews or credentials. The [file service](files.md), the
[setup](boxes.md#the-setup), the process list and the [terminal](terminal.md) are commands in the box, which the
orchestrator starts with `run` or `spawn`. So they work the same way on each runtime.

## Rules for each runtime

The orchestrator expects each runtime to follow these rules:

- `state` gives `running`, `stopped` or `unknown`. A container that is gone is `stopped`. `unknown` means that the
  runtime did not answer, and the orchestrator handles it as a running box, so that a failed read stops nothing.
- `ensure` creates or repairs the container and the isolation of a box, and it can run again with no effect. On a
  running box, it repairs only the isolation, and it does not change the container. `start` comes after `ensure` and
  gets the same spec, because a runtime can make the container only at the start.
- `run` stops a command after 60 seconds (`RUN_TIMEOUT_MS`) when the caller gives no other limit, and it keeps no more
  output than `maxOutput`.
- A stream from `spawn` can end at any time, and each caller must handle the end.
- `inventory` lists the objects of each box in the order in which they must be removed.
- A box can connect to the URL from `proxyUrl` and to nothing else.

## Selection

At boot, `buildApp` in `orchestrator/src/app.ts` makes the runtime that `RUNTIME` names with `createRuntime`, and sets
it with `setRuntime`.
The other modules get it with `runtime()`, which throws when no runtime is set. Each test sets the runtime it uses, and
the test setup removes it after each test.

## Conformance suite

The [conformance suite](development.md#runtime-conformance-suite) checks the rules above against a real runtime and the
real box image. CI runs it against Docker and against a kind cluster for each change.
