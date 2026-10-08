# Limitations

Linux support is not claimed until its suite and acceptance run there. Windows is unsupported. Client-data migration is not implemented. There is no backup or sync; a lost laptop can expose local data if disk protection is inadequate and can lose the only copy.

This pilot supports multi-record onboarding, with one registry publication point and crash/replay tests. The checks do not prove behavior against a malicious same-user process, real agent routing, live accounts, legal redistributability, or production readiness. Fresh-agent smoke checks are deferred until approved real-home activation.

The skill builder has deterministic workspace, format and disposable-installation tools. Its conversational `SKILL.md` and live-model behavior evaluation are deferred. Validation does not run generated helpers or prove that a skill asks good questions. B's tests prove file, approval and recovery guards only; they do not prove discovery, routing, fresh-session behavior or real-home readiness. The validator intentionally accepts a strict frontmatter subset described in [SKILL-BUILDER.md](SKILL-BUILDER.md). Export and publication remain unavailable.
