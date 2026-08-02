# Contributing

This repository is governed by
[playbook-engineering](https://github.com/qwts/playbook-engineering): shared
SOPs, decisions, and baselines there apply here by default.

- **Workflow**: branch → PR → review → merge, per the shared
  [branch, PR, and review SOP](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/branch-pr-review.md).
- **Features**: follow the
  [feature-lifecycle SOP](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/feature-lifecycle.md)
  — open the feature issue form before the code exists.
- **Security**: see the org
  [security policy](https://github.com/qwts/.github/blob/main/SECURITY.md);
  report vulnerabilities privately, never in a public issue.

## Validation lifecycle

This repository follows the shared
[CI execution policy](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/ci-execution-policy.md).
Before marking a draft pull request ready, run the complete local suite:

```bash
npm ci
npm run typecheck
npm test
npm run test:workflows
npm run lint:workflows
```

Ready pull requests run or reuse exact-commit evidence for those checks and
advanced CodeQL analysis. A validated commit pushed to `main` reuses that
exact-commit CodeQL evidence and runs only focused MCP and HTTP integration
smoke tests; a commit without exact evidence falls back to the complete suite,
including CodeQL.

Dependabot pull requests must use GitHub's **Create a merge commit** strategy.
Squash or rebase can leave a Dependabot-authored commit on `main` with a
read-only token that cannot upload the required CodeQL result; the complete
suite fails safely in that case. This constraint does not change the
repository-wide merge-method settings.

This repository has no configured build, formatting, Markdown-lint, docs-gov,
changeset, packaging, signing, or automated release gate.

Repo-specific gates and deltas, if any, are listed in this repo's `AGENTS.md`.
