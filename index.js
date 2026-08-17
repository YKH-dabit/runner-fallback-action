const core = require('@actions/core');
const httpClient = require('@actions/http-client');

async function checkRunner({
  token,
  primaryRunnerLabels,
  fallbackRunner,
  primariesRequired,
  apiPath,
}) {
  const http = new httpClient.HttpClient("http-client");
  const headers = {
    Authorization: `Bearer ${token}`,
  };

  const response = await http.getJson(
    `https://api.github.com/${apiPath}`,
    headers
  );

  if (response.statusCode !== 200) {
    return {
      error: `Failed to get runners. Status code: ${response.statusCode}`,
    };
  }

  const runners = response.result.runners || [];
  let useRunner = fallbackRunner;
  let primaryIsOnline = false;
  let sufficientPrimaries = false;
  let primariesAvailableCount = 0;

  for (const runner of runners) {
    if (runner.status === "online") {
      const runnerLabels = runner.labels.map((label) => label.name);
      if (primaryRunnerLabels.every((label) => runnerLabels.includes(label))) {
        primaryIsOnline = true;

        // Is the number of primaries important? If so, keep track of them
        if (primariesRequired !== undefined) {
          // if we need more primaries and this one is busy, keep looking
          if (runner.busy === true) {
           continue;
          }

          // if we still do not have enough primaries, keep looking
          primariesAvailableCount++;
          if (primariesAvailableCount < primariesRequired) {
            continue;
          }
        }

        sufficientPrimaries = true;
        useRunner = primaryRunnerLabels.join(",");
        break;
      }
    }
  }

  // return a JSON string so that it can be parsed using `fromJson`, e.g. fromJson('["self-hosted", "linux"]')
  return { useRunner: JSON.stringify(useRunner.split(",")), primaryIsOnline, sufficientPrimaries };
}

// Writing the job summary is best-effort: a summary failure must never change
// the outcome of the step (the runner output may already have been decided).
async function writeSummarySafe(text) {
  try {
    core.summary.addRaw(text);
    await core.summary.write();
  } catch (summaryError) {
    core.warning(`Failed to write job summary: ${summaryError.message || summaryError}`);
  }
}

// Single path for emitting the fallback runner output. `fallback-runner` is a
// comma-separated label list just like `primary-runner`, so it must be
// comma-split the same way the success path splits `primaryRunnerLabels`.
function emitFallbackRunner(fallbackRunner) {
  core.setOutput('use-runner', JSON.stringify(fallbackRunner.split(',')));
}

async function main() {
  // Defaults are chosen so that any error thrown before these are resolved
  // (e.g. a malformed `fallback-on-error` value) can never be mistaken for an
  // authorized "use the fallback" signal: fallbackOnError defaults to false,
  // and fallbackRunner stays undefined until it is actually read.
  let fallbackOnError = false;
  let fallbackRunner;

  try {
    // Read the two inputs that decide the failure path *before* anything that
    // can throw, so that if something below does throw, the catch block below
    // knows the real fallback-on-error / fallback-runner values rather than
    // treating an unrelated failure as "unknowable" fallback intent.
    fallbackOnError = core.getBooleanInput('fallback-on-error', { required: false });
    fallbackRunner = core.getInput('fallback-runner', { required: true });

    const githubRepository = process.env.GITHUB_REPOSITORY;
    if (!githubRepository) {
      throw new Error('GITHUB_REPOSITORY environment variable is not set.');
    }
    const [owner, repo] = githubRepository.split("/");

    const organization = core.getInput('organization', { required: false });
    const enterprise = core.getInput('enterprise', { required: false });
    if (organization && enterprise) {
      throw new Error('You cannot specify both organization and enterprise inputs. Please choose one.');
    }

    let apiPath = `repos/${owner}/${repo}/actions/runners`;
    if (organization) {
      apiPath = `orgs/${organization}/actions/runners`;
    } else if (enterprise) {
      apiPath = `enterprises/${enterprise}/actions/runners`;
    }

    const inputs = {
      apiPath,
      token: core.getInput('github-token', { required: true }),
      primaryRunnerLabels: core.getInput('primary-runner', { required: true }).split(','),
      fallbackRunner,
      primariesRequired: core.getInput('primaries-required', { required: false }),
    };

    const { useRunner, primaryIsOnline, sufficientPrimaries, error } = await checkRunner(inputs);

    if (error) {
      throw new Error(error);
    }

    core.info(`Primary runner is online: ${primaryIsOnline}`);
    core.info(`Sufficient primary runners available: ${sufficientPrimaries}`);
    core.info(`Using runner: ${useRunner}`);
    await writeSummarySafe(`Selected runner ${useRunner}. Check log for details.`);
    core.setOutput('use-runner', useRunner);
  } catch (error) {
    // A malformed fallback-on-error value throws out of getBooleanInput above
    // before fallbackRunner is even read, so fallbackRunner stays undefined
    // here and this always falls through to the clean setFailed below -
    // an unreadable flag can never be treated as "true".
    if (fallbackRunner !== undefined && fallbackOnError === true) {
      core.warning('Runner selection failed, but fallback-on-error is true - using the fallback runner');
      core.warning(`Original error: ${error.message || error}`);
      core.warning(`using runner: ${fallbackRunner}`);
      await writeSummarySafe(`Selected runner ${fallbackRunner}. Check log for details.`);
      emitFallbackRunner(fallbackRunner);
    } else {
      core.setFailed(error.message || String(error));
    }
  }
}

module.exports = { checkRunner, main };

if (require.main === module) {
  main().catch((error) => {
    // Defensive top-level guard: main() already catches everything internally,
    // but this ensures no failure mode can ever surface as an unhandled
    // rejection (fatal on Node 24) even if that invariant is broken later.
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
