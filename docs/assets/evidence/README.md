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

These files are evidence summaries, not replacement audit logs and not cryptographic attestations. They predate the release-evidence bundle protocol and must not be described as fresh evidence for the current `HEAD`. Reproduce a capability through the matching document in [`docs/demos/`](../../demos), then inspect the new local `.forge/sessions/<session-id>/` directory for the full record.

Offline eval reports follow the same redaction boundary but represent a different evidence shape. A promoted baseline contains only aggregate behavior counts and metrics. A candidate `report.md` contains compatibility, count differences, hard/infrastructure findings, and optional token/latency coverage. Local `.forge/evals/<run-id>/attempts/` data is never a public artifact. See [Offline eval and regression reports](../../offline-eval.md).

The curated [offline eval regression report](offline-eval-regression-report.md) records the first independent valid and comparable batch for its then-current hardened identity at source commit `6f4630a3c266433a1234a08b4b738c81516dcf99`. Its `REGRESSED` verdict is retained because one compaction ordering assertion declined even though async child handoff improved; the candidate was not resampled for a preferred verdict. The matching historical baseline is committed under [`eval/baselines/`](../../../eval/baselines/). It is not a baseline or fresh evidence claim for later Eval contract identities.

## Release bundle contract

Fresh release evidence is not committed here. A matching GitHub Release carries sanitized `release-manifest.json`, per-run manifests, and reports; the maintainer-only `ZophiaWong/forge-harness-evidence` companion repository carries the named raw archives and private inventories. The public manifest binds subject tag/commit/tree/clean state, collector commit/tree/clean state, environment identity, behavioral result, capture result, limitations, sizes, and SHA-256 values.

After downloading public and private assets, `npm run evidence -- verify` checks the complete byte relationship. Until that succeeds, a release claim remains unsupported even when its behavior passed. See the [Release evidence runbook](../../release-evidence.md).

## Evidence levels

| Level | What it establishes |
| --- | --- |
| Source contract | The implemented types and control flow define the intended boundary. |
| Automated test | A focused deterministic case exercises that boundary. |
| Deterministic smoke | Several components run together without a model API call. |
| Curated live snapshot | A model-driven run reached the expected Runtime invariants once. |
| Compatible regression report | A fixed candidate batch changed, preserved, or regressed scenario/assertion pass counts relative to one versioned baseline. |
| Fresh release evidence bundle | A preregistered clean tag run has sealed raw Session/attempt bytes, a sanitized public manifest, private inventory/archive linkage, and download-after-upload verification. |

A live snapshot does not make model behavior deterministic. The Runtime gate, state transition, verifier, or integration check is the deterministic part.
