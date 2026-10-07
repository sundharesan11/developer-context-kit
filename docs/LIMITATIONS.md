# Limitations

Linux support is not claimed until its suite and acceptance run there. Windows is unsupported. Client-data migration is not implemented. There is no backup or sync; a lost laptop can expose local data if disk protection is inadequate and can lose the only copy.

This pilot supports multi-record onboarding, with one registry publication point and crash/replay tests. The checks do not prove behavior against a malicious same-user process, real agent routing, live accounts, legal redistributability, or production readiness. Fresh-agent smoke checks are deferred until approved real-home activation.

The skill builder currently has deterministic workspace and format tools only. Its conversational `SKILL.md` and live-model behavior evaluation are deferred. Validation does not run generated helpers, prove that a skill asks good questions, or authorize installation or export. The validator intentionally accepts a strict frontmatter subset described in [SKILL-BUILDER.md](SKILL-BUILDER.md).
