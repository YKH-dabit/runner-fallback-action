const core = require('@actions/core');
const httpClient = require('@actions/http-client');

// GitHub org / user / enterprise names: alphanumeric, single hyphens only, no
// leading/trailing hyphen, 1-39 chars. This is the same shape GitHub enforces
// for org and user names; enterprise slugs are a subset of it. Rejecting
// anything outside this shape closes the `organization: "../../zen"`-style
// path-injection into the API URL below - the value can only ever become one
// path segment.
const GITHUB_NAME_PATTERN = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

function assertValidGithubName(name, inputName) {
  if (!GITHUB_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid ${inputName}: "${name}" is not a valid GitHub name (letters, digits, and single internal hyphens only; no leading/trailing hyphen).`
    );
  }
}

// Shared by every place a comma-separated label list is turned into an array:
// primary-runner at read time, and fallback-runner on both the success path
// (useRunner may fall through to the raw fallback string) and the
// fallback-on-error path in emitFallbackRunner. A label with stray
// whitespace (e.g. 'self-hosted, linux') must match the same runner as one
// without it.
function splitLabels(commaSeparated) {
  return commaSeparated.split(',').map((label) => label.trim());
}

// `primaries-required` is optional. `core.getInput` returns '' (never
// `undefined`) when the input is unset, so unset must be recognized
// explicitly rather than via `!== undefined` - otherwise unset silently
// takes the "count busy primaries against a threshold" branch with an empty
// string as the threshold. Unset means "no minimum requested": any online
// primary is used regardless of how busy it is, matching the README's
// description of `primaries-required` as an opt-in check. When set, it must
// be a positive integer; anything else is a configuration error, not a
// silently-ignored value.
function parsePrimariesRequired(rawValue) {
  if (rawValue === '' || rawValue === undefined) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Invalid primaries-required: "${rawValue}" must be a positive integer.`
    );
  }
  return parsed;
}

// Single error shape for every way the runners API call can fail: `getJson`
// *throws* an `HttpClientError` for 401 / 403 / 5xx, but *resolves* with a
// non-200 `statusCode` (and no error) for 404 - the two are the same failure
// ("could not get the runner list") wearing different clothes, and callers
// must not have to know which one they're looking at. `detail` carries
// GitHub's own explanation when one is available; it is deliberately never
// the raw request headers, so the token can never end up in this message.
function formatRunnersFetchError(statusCode, detail) {
  return `Failed to get runners. Status code: ${statusCode}${detail ? `: ${detail}` : ''}`;
}

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

  let response;
  try {
    response = await http.getJson(
      `https://api.github.com/${apiPath}`,
      headers
    );
  } catch (httpError) {
    // 401 / 403 / 5xx land here as a thrown HttpClientError. Transport
    // failures (DNS, TLS, timeout) reject with no statusCode - those keep
    // their own message rather than claiming a status code they don't have.
    if (typeof httpError.statusCode !== 'number') {
      throw new Error(`Failed to get runners: ${httpError.message || httpError}`);
    }
    throw new Error(formatRunnersFetchError(httpError.statusCode, httpError.message));
  }

  if (response.statusCode !== 200) {
    // 404 is the one case @actions/http-client resolves instead of throwing.
    const detail = response.result && response.result.message;
    throw new Error(formatRunnersFetchError(response.statusCode, detail));
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
  return { useRunner: JSON.stringify(splitLabels(useRunner)), primaryIsOnline, sufficientPrimaries };
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
  core.setOutput('use-runner', JSON.stringify(splitLabels(fallbackRunner)));
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
    if (organization) {
      assertValidGithubName(organization, 'organization');
    }
    if (enterprise) {
      assertValidGithubName(enterprise, 'enterprise');
    }

    let apiPath = `repos/${owner}/${repo}/actions/runners`;
    if (organization) {
      apiPath = `orgs/${organization}/actions/runners`;
    } else if (enterprise) {
      apiPath = `enterprises/${enterprise}/actions/runners`;
    }

    // Mask immediately after reading, before the token is used anywhere else,
    // so it is never logged unmasked even when it comes from a non-secret
    // source (`vars.` or a literal) rather than `secrets.`.
    const token = core.getInput('github-token', { required: true });
    core.setSecret(token);

    const inputs = {
      apiPath,
      token,
      primaryRunnerLabels: splitLabels(core.getInput('primary-runner', { required: true })),
      fallbackRunner,
      primariesRequired: parsePrimariesRequired(core.getInput('primaries-required', { required: false })),
    };

    const { useRunner, primaryIsOnline, sufficientPrimaries } = await checkRunner(inputs);

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
