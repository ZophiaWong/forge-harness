# Curated runtime evidence

This directory contains compact snapshots derived from local Forge Harness runs. A snapshot records the invariants observed in one run without publishing the raw Session directory.

Raw Session artifacts can contain:

- absolute filesystem paths and generated Git branch names;
- Session, message, request, and Tool Call identifiers;
- timestamps, model identifiers, prompts, and free-form model output;
- command output or project content read during the run.

Those fields are useful for local diagnosis but unsuitable as stable public fixtures. The committed snapshots replace them with aliases, summaries, or explicit redaction markers.

## Snapshot contract

Each JSON snapshot contains:

- `schemaVersion`: format version for the curated artifact;
- `capability`: the Runtime behavior exercised;
- `capture`: capture kind, source Runtime commit, and a stable run alias;
- `outcome`: the observed terminal status and round count;
- `assertions`: named invariants checked against Session metadata, Trace events, TaskGraph state, or output artifacts;
- `eventSequence`: the minimum ordered event chain needed to explain the result;
- `redactions`: fields removed or normalized during curation;
- `limitations`: what the snapshot does not prove.

These files are evidence summaries, not replacement audit logs and not cryptographic attestations. Reproduce a capability through the matching document in [`docs/demos/`](../../demos), then inspect the new local `.forge/sessions/<session-id>/` directory for the full record.

## Evidence levels

| Level | What it establishes |
| --- | --- |
| Source contract | The implemented types and control flow define the intended boundary. |
| Automated test | A focused deterministic case exercises that boundary. |
| Deterministic smoke | Several components run together without a model API call. |
| Curated live snapshot | A model-driven run reached the expected Runtime invariants once. |

A live snapshot does not make model behavior deterministic. The Runtime gate, state transition, verifier, or integration check is the deterministic part.
