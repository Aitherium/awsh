# Installing awsh

awsh ships as one program with three command names: `awsh`, `aither` and
`aither-shell`. They are the same binary, so any of them works in the examples
below.

## npm (every platform with Node)

```bash
npm i -g @aitherium/awsh
awsh --version
```

This needs Node 18 or newer (`engines.node` in `package.json`). The release
workflow also publishes a legacy mirror, `@aitherium/shell-cli`, which may be
older. Prefer `@aitherium/awsh`. There is no package called plain `awsh` on npm.

## Standalone binary (no Node)

Each release attaches single-file executables compiled with `bun`:

| platform | asset |
|---|---|
| Linux x64 | `aither-shell-linux-x64` |
| macOS Apple Silicon | `aither-shell-macos-arm64` |
| Windows x64 | `aither-shell-win64.exe` |

They are mirrored to the public release `shell-v<version>` at
`https://github.com/Aitherium/awdk/releases`, next to a `SHA256SUMS.txt`.
Check the digest before you run the binary:

```bash
v=1.17.0
curl -fsSLO https://github.com/Aitherium/awdk/releases/download/shell-v$v/aither-shell-linux-x64
curl -fsSL  https://github.com/Aitherium/awdk/releases/download/shell-v$v/SHA256SUMS.txt \
  | grep aither-shell-linux-x64 | sha256sum -c -
install -m 755 aither-shell-linux-x64 ~/.local/bin/awsh
```

No binary is built for Intel macOS or Linux arm64. On those machines, use npm.

## Homebrew

The formula is `packaging/brew/awsh.rb` in the
[awdk repository](https://github.com/Aitherium/awdk). It is a binary formula: it
downloads the release asset above, checks its sha256, and installs `awsh` with
`aither` and `aither-shell` links to it.

```bash
brew tap aitherium/tap
brew install awsh
```

The tap installs the formula only after it has been copied into
`Aitherium/homebrew-tap`. Until then, run
`brew install --formula ./packaging/brew/awsh.rb` from an awdk checkout.

## conda

The recipe is `packaging/conda/awsh/meta.yaml` in the awdk repository. It is not on conda-forge,
because conda-forge requires an OSI licence and awsh is BUSL-1.1. Build it
into a local channel like this:

```bash
conda build packaging/conda/awsh
conda install --use-local awsh
```

## winget

The manifests are in `packaging/winget/` in the awdk repository
(`Aitherium.AitherShell`).

## Staying in lockstep

The brew formula and the conda recipe pin the same version and the same
digests. A test fails when they drift apart, when a digest is a placeholder,
or when a URL names an asset the release does not upload. When you bump
either file, copy the digests from the release's `SHA256SUMS.txt`, never from a build log.

## After installing

Continue with [quickstart.md](quickstart.md). To make a mistyped line in your
own shell become a question, see `awsh init` in
[configuration.md](configuration.md#shell-integration-omnibox).
