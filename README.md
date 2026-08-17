# Github Runner Fallback Action

<p align="center">
  <a href="https://github.com/YKH-dabit/runner-fallback-action/actions"><img alt="javscript-action status" src="https://github.com/YKH-dabit/runner-fallback-action/workflows/units-test/badge.svg"></a>
</p>

Github action to determine the availability of self-hosted runners, and fallback to a GitHub runner if the primary runners are offline.

This action uses [GitHub API](https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2022-11-28#list-self-hosted-runners-for-a-repository) to check the statuses of self hosted-runners that match specific labels, and outputs the runner label(s), or a fallback runner if the self-hosted runner(s) is unavailable.

The API used requires a token that can read the runner list **for the context you point this action at**, and those contexts do not need the same amount of authority:

| Context | Input | Token |
| --- | --- | --- |
| Repository runners | none (default) | A fine-grained PAT limited to that repository with `Administration: Read`, or a classic PAT with the `repo` scope |
| Organization runners | `organization` | Org admin rights — a classic PAT with `admin:org`, or a fine-grained PAT with the organization's `Self-hosted runners: Read` permission |
| Enterprise runners | `enterprise` | Enterprise admin rights — e.g. a classic PAT with `manage_runners:enterprise` |

Prefer the narrowest token that covers your context. This token is handed to the action at runtime, so pointing an org-admin token at a single repository's runner list exposes far more authority than the call needs.

This output can then used on the `runs-on` property of subsequent jobs.

Note: In order to support an array of labels for the `runs-on` field, the output is formatted as a JSON string and needs to be parsed using `fromJson`. See example usage below.

## Usage

### ✏️ Inputs

#### Required

|       Name        |                                          Description                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
|  `github-token`   | A token that can access the `list action runners` for the given context (e.g. user repo, org, enterprise). |
|  `primary-runner` | A comma separated list of labels for the _primary_ runner (e.g. 'self-hosted,linux').                      |
| `fallback-runner` | A comma separated list of labels for the _fallback_ runner (e.g. 'self-hosted,linux').                     |

#### Optional

---

There are three ways runners can be allowed to run against a repo: User, Organization, Enterprise. The following options allow you to switch the implementation to use one of the other specified levels. **_Note:_** You can only provide one of the values.

|       Name       |                     Description                                    |
| ---------------- | ------------------------------------------------------------------ |
| `organization`   | The name of the github organization (e.g. `My-Github-Org`)         |
| `enterprise`     | The name of the github enterprise (e.g. `My-Github-Ent`)           |

It is possible that you want to use the fallback runners even if the primary runners are online,
if the primary runners are busy. You may optionally configure this action to fallback if there
are not enough free primaries, for example if you are adding self-hosted primaries to increase capacity, but the fallbacks are public runners in a public repo so you don't mind using them as needed.

|       Name           |                     Description                 |
| -------------------- | ----------------------------------------------- |
| `primaries-required` | minimum non-busy primaries count, else fallback |

`primaries-required` must be a positive integer when set. If omitted, no minimum is
enforced: any online primary is used regardless of how busy it is.

You may want the action to use the fallback runner, if correctly configured, if there are any
errors at all. This makes it so the action won't block CI runs even if (for example) the
github token is unavailable or expires. Default is false.

|       Name          |                     Description                 |
| ------------------- | ----------------------------------------------- |
| `fallback-on-error` | use the fallback runner if there are any errors |

### Example

```yaml
jobs:
  # We may have a self-hosted runner available. Use it if so.
  determine-runner:
    runs-on: ubuntu-latest
    concurrency:
      # Runner choice must happen serially for the "primaries-required" logic
      # to be up to date in the context of one self-hosted runner that may be
      # used for multiple workflows triggered off the same workflow event
      group: runner-determination
      cancel-in-progress: false
    outputs:
      runner: ${{ steps.set-runner.outputs.use-runner }}
    steps:
      - name: Wait for possible parallel workflow run job startup lag
        # After runner choice, the job that will use it has unavoidable job startup lag
        # Wait for that job start / runner state change before we choose the runner for this run
        run: sleep 15
      - name: Use self-hosted runner if online and not busy, otherwise public runner
        id: set-runner
        uses: YKH-dabit/runner-fallback-action@v1
        with:
          organization: "ankidroid"
          # list of tags a runner must match to be considered a primary
          primary-runner: "macos-selfhosted"
          # a single tag that will select a runner to fallback to
          fallback-runner: "macos-26"
          # optional, fallback if fewer available, big batch jobs or multiple workflows perhaps
          primaries-required: 1
          # optional, fallback if token expires or github API fails
          fallback-on-error: true
          # Must have org:admin permissions, github runner APIs require it
          # Note that Actions secrets and Dependabot secrets are separate
          github-token: ${{ secrets.MIKE_HARDY_ORG_ADMIN_KEY }}

  another-job:
    needs: determine-runner
    runs-on: ${{ fromJson(needs.determine-runner.outputs.runner) }}
    steps:
      - name: Do something
        run: echo "Doing something on ${{ needs.determine-runner.outputs.runner }}"
```

- Here is an example of the action in use directly: <https://github.com/ankidroid/Anki-Android-Backend/blob/main/.github/workflows/build-release.yml>

- Here is an example where the runner is used in a second preparation step that builds a dynamic job matrix where the runner is used in javascript: <https://github.com/ankidroid/Anki-Android-Backend/blob/main/.github/workflows/build-quick.yml>

## Developing this action

### Never register a self-hosted runner on this repository

`test-output` in `.github/workflows/test.yml` runs on whatever labels this action resolves. With zero runners registered that can only ever be the fallback (a GitHub-hosted runner). Registering a self-hosted runner here would let labels chosen by a pull request place a job on our own hardware — on a public repository that turns a bad PR into arbitrary code execution on our machine. Nothing in CI needs one: the end-to-end tests assert the *fallback* path precisely because no primary runner exists.

### The end-to-end tests are behind a review gate

`test` and `test-multiple-labels` use `uses: ./`, which executes the checked-out `dist/index.js` of the run they are in, with `TEST_GITHUB_TOKEN` available. They are therefore gated behind the `e2e-tests` environment, which has a required reviewer: the run pauses and the secret cannot be read until someone approves it.

**Approving that environment means agreeing to run the pull request's code with the token.** Before approving, read the diff to `dist/`, `package.json` scripts, and `.github/workflows/`. "Is this change a good idea" is the code review; this is a separate question.

A few properties of that setup are deliberate and easy to break by accident:

- `TEST_GITHUB_TOKEN` is an **environment** secret, not a repository secret. A repository secret would be readable by any run on any branch, which would put the token back within reach of unreviewed code.
- It is a fine-grained PAT limited to this repository with `Administration: Read` and nothing else. `GITHUB_TOKEN` cannot substitute for it — the workflow `permissions:` key has no `administration` scope.
- **The current token expires 2026-11-15** (issued 2026-08-17 with a 90-day lifetime). From that day the e2e jobs fail with `Failed to get runners. Status code: 401` instead of skipping, which is intended — but it means the fix is "rotate the token and update this date", not "debug CI". Rotating it means regenerating the PAT with the same permission and re-running `gh secret set TEST_GITHUB_TOKEN --env e2e-tests`.
- "Prevent self-review" is intentionally **off**. With a single maintainer the only possible reviewer is the PR author, and GitHub never requests review from the author, so enabling it would permanently block the e2e tests instead of adding a second pair of eyes. Revisit once there is a second collaborator.
- If the secret is absent the token-dependent steps skip rather than fail, so a fork's CI is not permanently red. An expired or revoked token is a different case and fails loudly with a 401.

## Credit

- this action is based on the pattern described by @ianpurton on [this feature request thread](https://github.com/orgs/community/discussions/20019#discussioncomment-5414593).

- this action was originally developed by @jimmygchen - thanks Jimmy! [He has decided to archive his original action](https://github.com/jimmygchen/runner-fallback-action/pull/31#issuecomment-3454512133), and this fork is the successor

- @mikehardy picked up maintenance after Jimmy archived the original, continuing it as [mikehardy/runner-fallback-action](https://github.com/mikehardy/runner-fallback-action) - thanks Mike! This repo is forked from that line of maintenance.

- @O-Mutt contributed the organization-level and enterprise-level self-hosted runner feature, thanks Matt!
