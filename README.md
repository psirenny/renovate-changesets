<!-- markdownlint-disable MD033 MD041 -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo-dark.svg">
  <img src="logo-light.svg" alt="Renovate to Changesets" height="72">
</picture>
<!-- markdownlint-enable MD033 MD041 -->

# renovate-changesets

[![CI](https://github.com/psirenny/renovate-changesets/actions/workflows/ci.yaml/badge.svg)](https://github.com/psirenny/renovate-changesets/actions/workflows/ci.yaml)

A Renovate `postUpgradeTask` to generate [changesets](https://github.com/changesets/changesets) from dependency updates.
This is intentionally _not_ a GitHub Action because inferring dependencies from a Renovate pull request is rife with
errors.

## Examples

**packages/api/CHANGELOG.md**

```markdown
# api

## 1.2.4

### Patch Changes

- Pinned [hono](https://github.com/honojs/hono) to `4.13.7`.
- Updated [zod](https://github.com/colinhacks/zod) from `4.5.4` to `4.6.1`.
- Updated the `cargo` lockfile.
- Replaced `eslint` with `oxlint` `1.82.0`.
- Updated `node` from `24.8.0-alpine` to `24.9.0-alpine`.
```

**packages/application/CHANGELOG.md**

```markdown
# application

## 1.2.4

### Patch Changes

- Updated `postgres` from `18.1` to `18.2`.
- Replaced `eslint` with `oxlint` `1.82.0`.
- Updated [zod](https://github.com/colinhacks/zod) from `4.5.4` to `4.6.1`.
- Updated [next](https://github.com/vercel/next.js) from `15.2.2` to `15.2.3`. [Security: CRITICAL]
- Rolled back [vitest](https://github.com/vitest-dev/vitest) to `4.1.10`.
```

## Support

| Ecosystem          | Supported |
| ------------------ | --------- |
| Bun                | 🚧        |
| Cargo              | ✅        |
| Custom managers    | ✅        |
| Deno               | ✅        |
| Docker             | ✅        |
| Docker Compose     | ✅        |
| GitHub Actions     | ✅        |
| Go                 | 🚧        |
| mise / asdf        | ✅        |
| Node version files | 🚧        |
| NPM                | ✅        |
| PNPM               | ✅        |
| uv                 | 🚧        |
| Yarn               | ✅        |

## Installation

Install the plugin:

```shell
pnpm add --save-dev --save-exact renovate renovate-changesets
```

## Usage

Configure Renovate:

**renovate.json**

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "postUpgradeTasks": {
    "commands": ["pnpm install --frozen-lockfile --ignore-scripts", "pnpm renovate-changesets"],
    "dataFileTemplate": "{{{toJSON upgrades}}}",
    "executionMode": "branch"
  }
}
```

Each changeset is written to `.changeset/` and formatted with the formatter that `format` in `.changeset/config.json`
selects, as `changeset add` does. Packages that `.changeset/config.json` leaves out get no changeset: anything matched
by `ignore`, and private packages unless `privatePackages.version` is enabled.

**.github/workflows/renovate.yaml**

```yaml
name: Renovate
on:
  schedule:
    - cron: "0 0 * * *"
  workflow_dispatch:
    inputs:
      is-dry-run:
        description: Whether this is a dry run. If true, Renovate will resolve updates without opening pull requests.
        type: boolean
        default: false
      log-level:
        description: The log level to use for Renovate.
        type: choice
        default: info
        options:
          - trace
          - debug
          - info
          - warn
          - error
          - fatal
concurrency:
  cancel-in-progress: true
  group: renovate
jobs:
  renovate:
    name: Renovate
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout Git repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Install PNPM
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          cache: pnpm
          node-version-file: .node-version
      - name: Install Node.js dependencies
        run: pnpm install
      - name: Run Renovate
        env:
          LOG_FILE: ${{ runner.temp }}/renovate.log
          LOG_FILE_LEVEL: info
          LOG_LEVEL: ${{ inputs.log-level }}
          RENOVATE_ALLOWED_COMMANDS:
            '["^pnpm install --frozen-lockfile --ignore-scripts$", "^pnpm renovate-changesets$"]'
          RENOVATE_ALLOW_SHELL_EXECUTOR_FOR_POST_UPGRADE_COMMANDS: "true"
          RENOVATE_BINARY_SOURCE: global
          RENOVATE_DRY_RUN: ${{ inputs.is-dry-run == true && 'full' || '' }}
          RENOVATE_GITHUB_COM_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          RENOVATE_REPOSITORIES: ${{ github.repository }}
        run: pnpm exec renovate
      - name: Assert Renovate reported no warnings or errors
        if: ${{ !cancelled() }}
        env:
          log_file_path: ${{ runner.temp }}/renovate.log
        run: |
          if [[ -s "${log_file_path}" ]]; then
            cat "${log_file_path}"
            exit 1
          fi
```

## Recommended configurations

**pnpm-workspace.yaml**

```yaml
# yaml-language-server: $schema=https://www.schemastore.org/pnpm-workspace.json
# …
minimumReleaseAge: 4320
minimumReleaseAgeStrict: false
pmOnFail: download
strictDepBuilds: false
```

`minimumReleaseAge` is the PNPM side of Renovate's `security:minimumReleaseAgeNpm` preset, which holds back an update
until its release is three days old. Keep the two configuration values in sync: 4320 minutes is those three days.

`minimumReleaseAgeStrict` has to be disabled, because PNPM enables it as soon as you set `minimumReleaseAge`. But strict
mode conflicts with the `pnpm update --no-save` command Renovate uses when a new version satisfies the range in
`package.json`.

`pmOnFail` decides what PNPM does when it can't switch to the version of PNPM specified in the `package.json`
`packageManager` field. When PNPM itself is updated, there's a discrepancy between the version of PNPM Renovate runs
during an update and the version of PNPM that it's upgrading to. `download` fetches the declared version instead of
failing the post-upgrade commands or carrying on with the old version and writing the lockfile with it.

`strictDepBuilds` fails when a dependency introduces a build script that isn't in the `allowBuilds` list. Most of the
time these build scripts are optional or unnecessary. It's recommended to ignore build scripts because adding them to
the `allowBuilds` list requires cumbersome human intervention which hurts automated dependency updates. It's preferred
to skip failing build scripts and catch any potential problems in CI instead.

**renovate.json**

```jsonc
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  // …
  "commitMessageExtra": "to `{{#if isPinDigest}}{{{newDigestShort}}}{{else}}{{#if isMajor}}{{prettyNewMajor}}{{else}}{{#if isSingleVersion}}{{prettyNewVersion}}{{else}}{{#if newValue}}{{{newValue}}}{{else}}{{{newDigestShort}}}{{/if}}{{/if}}{{/if}}{{/if}}`",
  "commitMessageTopic": "`{{{depName}}}`",
  "gitIgnoredAuthors": ["12345678+your-bot[bot]@users.noreply.github.com"],
  "platformCommit": "enabled",
}
```

`commitMessageTopic`, `commitMessageExtra` modify pull request titles to match the text generated in Changeset messages.

`platformCommit` allows Renovate to sign commits by using the Git platform API instead of using Git directly.

`gitIgnoredAuthors` has to include the app or bot account that platform commits are attributed to. Renovate tries to
stay out of the way when it notices people committing to a branch, and it only recognizes `gitAuthor` and
`noreply@github.com` by default. We need to tell Renovate that the app/bot accounts aren't real people.
