<!-- markdownlint-disable MD033 MD041 -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo-dark.svg">
  <img src="logo-light.svg" alt="Renovate to Changesets" height="72">
</picture>
<!-- markdownlint-enable MD033 MD041 -->

# renovate-changesets

[![CI](https://github.com/psirenny/renovate-changesets/actions/workflows/ci.yaml/badge.svg)](https://github.com/psirenny/renovate-changesets/actions/workflows/ci.yaml)

A Renovate plugin to generate [changesets](https://github.com/changesets/changesets) from dependency updates.

## Installation

Install the plugin:

```shell
pnpm add --save-dev --save-exact renovate renovate-changesets
```

## Usage

Configure Renovate:

<!-- markdownlint-disable MD036 -->

**renovate.json**

<!-- markdownlint-enable MD036 -->

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "postUpgradeTasks": {
    "commands": [
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm renovate-changesets '{{{encodeBase64 (toJSON upgrades)}}}'"
    ],
    "executionMode": "branch"
  }
}
```

Each changeset is written to `.changeset/` and formatted with the formatter that `format` in `.changeset/config.json`
selects, as `changeset add` does.

<!-- markdownlint-disable MD036 -->

**.github/workflows/renovate.yaml**

<!-- markdownlint-enable MD036 -->

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
            '["^pnpm install --frozen-lockfile --ignore-scripts$", "^pnpm renovate-changesets"]'
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
