# Security model

The pilot fence and private file modes reduce accidental writes and reading. Source reads hold a no-follow descriptor, compare its identity before and after reading, and recheck ancestor identity. A residual race remains: a malicious same-user process can swap an ancestor between path checks or before later use. This is not a sandbox.

The core has no automatic private-to-public synchronization. A chosen agent host may transmit selected context to its provider, and direct tools can bypass this CLI's routing and fake connector checks. G-REPO and G-HOME are narrow metadata tripwires, not byte identity.

The root-free `skill-sources catalog` route reads only the bundled public catalog. `skill-sources check` makes unauthenticated, read-only requests to the GitHub API for repository, release, tag and commit metadata. GitHub sees the caller's IP; its unauthenticated limit is roughly 60 requests per hour, and each check can use up to eight requests. These routes write no local files and make no installation or safety claim. Redirects, response sizes and time are bounded; no upstream code is downloaded or executed.
