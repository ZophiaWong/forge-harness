# Design studies

The main branch keeps four concise notes on Runtime decisions at the c17c boundary. Each starts from a concrete Forge problem, describes the implemented mechanism, compares a small set of current coding-agent designs, and states the trade-off.

These notes are not a market survey or a feature plan. External systems change quickly, so their comparison claims link to official documentation.

## Current main studies

- [Context management](context-management.md)
- [Tool Runtime](tool-runtime.md)
- [Session persistence](session-persistence.md)
- [Multi-agent coordination](multi-agent-coordination.md)

For the integrated view, read the [Architecture overview](../architecture-overview.md), [Engineering case study](../engineering-case-study.md), and [Evidence Index](../evidence-index.md).

## Deep research archive

For the frozen, source-level study, read [Agent Runtime Design Studies](https://github.com/ZophiaWong/forge-harness/tree/research/agent-runtime-design-studies/docs/design-studies) on the separate `research/agent-runtime-design-studies` branch. The archive covers loop completion, tool boundaries, context construction, Session continuity, delegation, coordination, and extension trust across Forge, Pi, and a provenance-limited Claude local snapshot.

The archive uses frozen code, tests, documentation, history evidence, and explicit confidence labels. It is supporting research rather than a source of current product behavior. Its Claude material comes from a non-official local snapshot and does not establish equivalence to the current official Claude Code product.
