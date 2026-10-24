# Service composition notices

The app now optionally links `@dshfiles/bot-openai-dot`, an AGPL-3.0-only protocol port. The combined service is therefore declared AGPL-3.0-only, not an MIT-only distribution. The full AGPL text is preserved verbatim in LICENSE. The original MIT notice for earlier app code remains in LICENSE-MIT; dependency notices and licenses remain in their packages.

The Dot adapter preserves its full source, tests, license, NOTICE and PROVENANCE. Its protocol port is pinned to [Beeper chatgpt-dots ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb](https://github.com/beeper/chatgpt-dots/tree/ee43cb5c2b8a27e0759d74fb14b24d749ce01fdb). The separate fixture-only viewer port retains its MIT upstream notices in that package; it is not started by this service composition.

This app packages its source, tests and build configuration alongside compiled output. No external image publication is authorized by the local smoke tests. Before redistribution or serving modified covered work to other users, provide the complete corresponding source and applicable network-use source offer, including the full repository revision, root build configuration/lockfile and modifications required to rebuild it. A minimal runtime image or these app sources alone must not be represented as a complete source offer.

No provider credential values, browser profiles, cookies or real message histories belong in source packages, build contexts, images, notices or logs.
