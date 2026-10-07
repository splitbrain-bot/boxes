# Boxes specific Instructions

The house rules apply!

When unsure about anything, ask the user.

## Backwards Compatibility

Generally we don't care about backwards compatibility beyond using database migrations. We do not guarantee that a new
version of Boxes can read the data of an older version. Individual boxes can always be deleted and recreated. So don't
go out of your way to ensure smooth upgrades. Let the user know about breaking changes, and let them decide what to do.

## Security Threat Model

We mostly leave protection against malicious external users to the reverse proxy that should sit in front of Boxes. Thus
authentication is mostly out of scope.

We treat agents inside a box not as malicious but potentially dangerous. They might make mistakes or be ill-informed.
Isolating them from the Docker host and the orchestrator is the main security measure. The egress proxy and its policy
are meant mostly a defense against accidental leaks of secrets.

We trust the end user using Boxes - standard security practices apply anyway.

## Documentation

Documentation is kept in individual markdown files the `doc` directory of the repository. You are encouraged to read
them. The [README.md](README.md) gives an overview of the project and links to the other documents.

When you create new features or change existing ones, check what documentation needs to be updated. Suggest the changes
to the user. Do not create or change documentation without asking the user first. The user will decide what to do!

You may also suggest changes to this document, when you think it would improve your future work.

### Writing Style

Use a brief and precise writing style! Use ASD-STE100 Simplified Technical English. If you can say it simpler, say it
simpler.

Keep line lengths to 120 characters (tables and diagrams may exceed that).

Keep in mind: a box is a container, it does nothing but encapsulating other components. Whenever you are tempted to
write that a box does something, you are most likely wrong. There is a more precise thing to name that does the thing
you describe: the orchestrator, the agent, the harness, an environment variable, etc. But usually not a box.
