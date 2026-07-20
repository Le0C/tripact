# Routing work to models

tripact emits work as typed tasks. Each task carries a class describing what kind of work it is, and
`routing:` in `tripact.yaml` maps a class to an effort tier so a driving harness can send judgement
work to a stronger model than mechanical work.

## Routing a task class to an effort tier

Add a `routing:` map to `tripact.yaml`, keyed by task class:

```yaml
routing:
  adjudicate: judgment
  write-tests: implementation
  regenerate-derived: mechanical
```

- Give each key one of the task classes listed below.
- Give each value one of the effort tiers `judgment`, `planning`, `implementation`, or `mechanical`.
- Run `tripact check` to confirm the config validates. An unknown class or tier fails with exit code
  2, and every problem in the file is reported in one pass rather than one per run.

A class you do not route carries no effort or model hint at all, and its emitted tasks simply omit
those fields. A partial map is a valid map: you declare the classes you want to bind and the harness
decides what to do with the rest.

The task classes you can route:

<!-- tripact:task-classes -->
- `write-tests`
- `reconcile-stale`
- `fix-orphan-tag`
- `cover-section`
- `reconcile-layers`
- `adjudicate`
- `derive-prescriptive`
- `derive-descriptive`
- `derive-verificatory`
- `regenerate-derived`
<!-- /tripact:task-classes -->

Effort tiers are consumed by the harness, not by the kernel. tripact reports which tier a task
resolved to and stops there; what model that tier means is the harness's decision.
