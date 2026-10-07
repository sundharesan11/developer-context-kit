# Storage

Configuration, data and state are separate private roots inside a pilot. A registry snapshot is the only project visibility switch. Records and manifests are immutable; successors supersede earlier records. Locks are never broken automatically, and orphan staging remains for explicit repair. New private files use mode 0600 and private directories use 0700.
