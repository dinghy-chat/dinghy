# Releasing Dinghy

`main` holds merged work that is not released yet. A release is a version tag such as `v0.9.0`, with an image at `ghcr.io/dinghy-chat/dinghy:0.9.0` and a GitHub Release. Merging a pull request into `main` releases nothing.

```
pull requests ──merge──► main
                          │ after every merge, the Release workflow rebuilds one pull request
                          ▼
                 "Release 0.9.0" pull request
                          │ a maintainer merges it when main should ship
                          ▼
   tag v0.9.0 ──► Image workflow: tests, builds amd64 and arm64, publishes the image
                          ├──► GitHub Release, with the version's CHANGELOG section as notes
                          └──► Dinghy Cloud deploy
```

## The release pull request

The Release workflow (`.github/workflows/release.yml`) runs `scripts/release-prepare.sh` on every push to `main`. The script dates the `## [Unreleased]` section of `CHANGELOG.md`, moves the version in every file that names it, and rebuilds the lock file and the docs pages. The workflow pushes the result to the `release` branch and opens or updates the "Release X.Y.Z" pull request. When the Unreleased section is empty, it closes that pull request.

The version comes from the groups under Unreleased, following [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

| Unreleased holds                   | Before 1.0 | From 1.0 |
| ---------------------------------- | ---------- | -------- |
| `Upgrading` or `Removed`           | minor      | major    |
| `Added`, `Changed` or `Deprecated` | minor      | minor    |
| Only `Fixed` or `Security`         | patch      | patch    |

To release another version, run `scripts/release-prepare.sh 1.0.0` on a branch and open the pull request by hand.

The pull request skips the CI job: each change in it already passed CI, and the Image workflow runs CI again on the tag before it publishes anything.

## After the merge

The Release workflow sees that `package.json` names a version with no tag, and tags the merge commit. The tag starts the Image workflow. It publishes the image only after the tests, the image checks, the vulnerability scan, the install check and the upgrade check pass on both architectures. Then it creates the GitHub Release and starts the Dinghy Cloud deploy.

If the Image workflow fails, the tag has no image, and nothing deploys. `main` already names the new version in `README.md`, `compose.yaml` and the docs, so an install that follows them fails until the next release. Fix the problem on `main` at once, and merge the next release pull request.

## Self-hosted installs

A self-hosted install runs the version that its `compose.yaml` names, and upgrades only when its owner runs the upgrade in [docs/self-hosting.md](docs/self-hosting.md). To hear about new versions, watch this repository and choose **Releases**.
