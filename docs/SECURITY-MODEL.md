# Security model

The pilot fence and private file modes reduce accidental writes and reading. Source reads hold a no-follow descriptor, compare its identity before and after reading, and recheck ancestor identity. A residual race remains: a malicious same-user process can swap an ancestor between path checks or before later use. This is not a sandbox.

The core has no automatic private-to-public synchronization. A chosen agent host may transmit selected context to its provider, and direct tools can bypass this CLI's routing and fake connector checks. G-REPO and G-HOME are narrow metadata tripwires, not byte identity.
