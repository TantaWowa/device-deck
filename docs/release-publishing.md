# Publish Mac installers

The Mac distribution GitHub Actions workflow builds and tests Apple Silicon and Intel installers. Pull requests build and prove packages without publishing. Run the workflow on main with `publish` enabled to publish a GitHub release using the version in package.json. Increment the version before a new release; existing release assets are not overwritten.

Downloads are public and require no license. `devdeck update check` queries GitHub Releases. `devdeck update download` verifies the asset size and GitHub SHA-256 digest before saving the installer. It does not install or restart the running service. Finish reservations and recordings before installing.

Default packages have ad-hoc app signatures and unsigned installers. Signed, notarized packages can be built locally with `npm run package:mac -- --release` and the Apple signing settings documented in macos-distribution.md.
