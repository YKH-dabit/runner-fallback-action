const { checkRunner } = require('./index');
const mockGetJson = jest.fn();

jest.mock('@actions/http-client', () => {
  // Mirrors the real @actions/http-client shape closely enough for tests:
  // getJson() throws this for 401 / 403 / 5xx, carrying `.statusCode` and a
  // GitHub-supplied `.message` - see `_processResponse` in the real package.
  // Defined inside the factory because jest.mock() factories may not close
  // over out-of-scope variables.
  class MockHttpClientError extends Error {
    constructor(message, statusCode) {
      super(message);
      this.name = 'HttpClientError';
      this.statusCode = statusCode;
    }
  }

  return {
    HttpClient: jest.fn().mockImplementation(() => {
      return {
        getJson: mockGetJson,
      };
    }),
    BearerCredentialHandler: jest.fn(),
    HttpClientError: MockHttpClientError,
  };
});

// The mocked module's own export, so every test constructs the same class
// `index.js`'s `catch (httpError)` will see.
const { HttpClientError } = require('@actions/http-client');

jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  setSecret: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
  summary: {
    addRaw: jest.fn(),
    write: jest.fn(),
  },
}));

describe('checkRunner', () => {
  beforeEach(() => {
    mockGetJson.mockClear();
  });

  it('should use the primary runner if it is online', async () => {
    mockGetJson.mockResolvedValue({
      statusCode: 200,
      result: {
        runners: [
          {
            status: 'online',
            busy: true,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
          {
            status: 'online',
            busy: false,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
        ],
      },
    });

    const result = await checkRunner({
      token: 'fake-token',
      apiPath: 'repos/fake-owner/fake-repo/actions/runners',
      primaryRunnerLabels: ['self-hosted', 'linux'],
      fallbackRunner: 'ubuntu-latest',
      primariesRequired: 1,
    });

    expect(result).toEqual({
      useRunner: '["self-hosted","linux"]',
      primaryIsOnline: true,
      sufficientPrimaries: true,
    });
  });

  it('should use the fallback runner if primaries are online but busy', async () => {
    mockGetJson.mockResolvedValue({
      statusCode: 200,
      result: {
        runners: [
          {
            status: 'online',
            busy: true,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
          {
            status: 'online',
            busy: true,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
          {
            status: 'online',
            busy: false,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
        ],
      },
    });

    const result = await checkRunner({
      token: 'fake-token',
      apiPath: 'repos/fake-owner/fake-repo/actions/runners',
      primaryRunnerLabels: ['self-hosted', 'linux'],
      fallbackRunner: 'ubuntu-latest',
      primariesRequired: 3,
    });

    expect(result).toEqual({
      useRunner: '["ubuntu-latest"]',
      primaryIsOnline: true,
      sufficientPrimaries: false,
    });
  });

  it('should use the fallback runner if the primary is not online', async () => {
    mockGetJson.mockResolvedValue({
      statusCode: 200,
      result: {
        runners: [
          {
            status: 'offline',
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
        ],
      },
    });

    const result = await checkRunner({
      token: 'fake-token',
      apiPath: 'repos/fake-owner/fake-repo/actions/runners',
      primaryRunnerLabels: ['self-hosted', 'linux'],
      fallbackRunner: 'ubuntu-latest',
    });

    expect(result).toEqual({
      useRunner: '["ubuntu-latest"]',
      primaryIsOnline: false,
      sufficientPrimaries: false,
    });
  });

  it('trims whitespace from a comma-separated fallback runner returned by checkRunner itself', async () => {
    mockGetJson.mockResolvedValue({
      statusCode: 200,
      result: {
        runners: [
          {
            status: 'offline',
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
        ],
      },
    });

    const result = await checkRunner({
      token: 'fake-token',
      apiPath: 'repos/fake-owner/fake-repo/actions/runners',
      primaryRunnerLabels: ['self-hosted', 'linux'],
      fallbackRunner: 'ubuntu-latest, arm64',
    });

    expect(result).toEqual({
      useRunner: '["ubuntu-latest","arm64"]',
      primaryIsOnline: false,
      sufficientPrimaries: false,
    });
  });

  describe('alternative api handling', () => {
    it('should query organization runners if organization is provided', async () => {
      mockGetJson.mockResolvedValue({
        statusCode: 200,
        result: {
          runners: [],
        },
      });

      await checkRunner({
        token: "fake-token",
        apiPath: 'orgs/call-me-ishmael/actions/runners',
        primaryRunnerLabels: ["self-hosted", "linux"],
        fallbackRunner: "ubuntu-latest",
      });

      expect(mockGetJson).toHaveBeenCalledWith(
        "https://api.github.com/orgs/call-me-ishmael/actions/runners",
        expect.anything()
      );
    });
    it('should query enterprise runners if enterprise is provided', async () => {
      mockGetJson.mockResolvedValue({
        statusCode: 200,
        result: {
          runners: [],
        },
      });

      await checkRunner({
        token: 'fake-token',
        apiPath: 'enterprises/i-am-the-enterprise-now/actions/runners',
        primaryRunnerLabels: ['self-hosted', 'linux'],
        fallbackRunner: 'ubuntu-latest',
      });

      expect(mockGetJson).toHaveBeenCalledWith(
        "https://api.github.com/enterprises/i-am-the-enterprise-now/actions/runners",
        expect.anything()
      );
    });
  });

  describe('error path unification', () => {
    it.each([401, 403, 500, 503])(
      'throws a unified error when getJson rejects with an HttpClientError (status %i, the throw source)',
      async (statusCode) => {
        mockGetJson.mockRejectedValue(new HttpClientError('Bad credentials', statusCode));

        await expect(
          checkRunner({
            token: 'fake-token',
            apiPath: 'repos/fake-owner/fake-repo/actions/runners',
            primaryRunnerLabels: ['self-hosted', 'linux'],
            fallbackRunner: 'ubuntu-latest',
          })
        ).rejects.toThrow(`Failed to get runners. Status code: ${statusCode}: Bad credentials`);
      }
    );

    it('throws a unified error when getJson resolves with a non-200 statusCode (404, the statusCode source)', async () => {
      mockGetJson.mockResolvedValue({ statusCode: 404, result: null });

      await expect(
        checkRunner({
          token: 'fake-token',
          apiPath: 'repos/fake-owner/fake-repo/actions/runners',
          primaryRunnerLabels: ['self-hosted', 'linux'],
          fallbackRunner: 'ubuntu-latest',
        })
      ).rejects.toThrow('Failed to get runners. Status code: 404');
    });

    it('includes the GitHub-supplied detail when a non-200 statusCode response carries a body message', async () => {
      mockGetJson.mockResolvedValue({ statusCode: 404, result: { message: 'Not Found' } });

      await expect(
        checkRunner({
          token: 'fake-token',
          apiPath: 'repos/fake-owner/fake-repo/actions/runners',
          primaryRunnerLabels: ['self-hosted', 'linux'],
          fallbackRunner: 'ubuntu-latest',
        })
      ).rejects.toThrow('Failed to get runners. Status code: 404: Not Found');
    });

    it('never includes the Authorization header or token in the thrown error message', async () => {
      mockGetJson.mockRejectedValue(new HttpClientError('Bad credentials', 401));

      let thrown;
      try {
        await checkRunner({
          token: 'super-secret-token',
          apiPath: 'repos/fake-owner/fake-repo/actions/runners',
          primaryRunnerLabels: ['self-hosted', 'linux'],
          fallbackRunner: 'ubuntu-latest',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      expect(thrown.message).not.toContain('super-secret-token');
    });
  });
});

describe('main', () => {
  const core = require('@actions/core');
  const originalEnv = process.env;
  let main;

  function setInputs(overrides = {}) {
    const values = {
      'fallback-runner': 'ubuntu-latest',
      'github-token': 'fake-token',
      'primary-runner': 'self-hosted,linux',
      organization: '',
      enterprise: '',
      'primaries-required': '',
      ...overrides,
    };
    core.getInput.mockImplementation((name, options) => {
      const value = values[name] !== undefined ? values[name] : '';
      if (options && options.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    });
  }

  beforeEach(() => {
    process.env = { ...originalEnv, GITHUB_REPOSITORY: 'octocat/hello-world' };
    core.getInput.mockReset();
    core.getBooleanInput.mockReset();
    core.setOutput.mockReset();
    core.setFailed.mockReset();
    core.setSecret.mockReset();
    core.warning.mockReset();
    core.info.mockReset();
    core.summary.addRaw.mockReset();
    core.summary.write.mockReset().mockResolvedValue(undefined);
    mockGetJson.mockReset();
    ({ main } = require('./index'));
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('falls back cleanly when organization and enterprise are both set and fallback-on-error is true', async () => {
    core.getBooleanInput.mockReturnValue(true);
    setInputs({ organization: 'my-org', enterprise: 'my-enterprise' });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });

  it('setFailed cleanly (not an uncaught exception) when organization and enterprise are both set and fallback-on-error is false', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ organization: 'my-org', enterprise: 'my-enterprise' });

    await main();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('cannot specify both'));
  });

  it('falls back cleanly when GITHUB_REPOSITORY is missing and fallback-on-error is true', async () => {
    delete process.env.GITHUB_REPOSITORY;
    core.getBooleanInput.mockReturnValue(true);
    setInputs();

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });

  it('setFailed cleanly when GITHUB_REPOSITORY is missing and fallback-on-error is false', async () => {
    delete process.env.GITHUB_REPOSITORY;
    core.getBooleanInput.mockReturnValue(false);
    setInputs();

    await main();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('GITHUB_REPOSITORY'));
  });

  it('setFailed cleanly (never takes the fallback branch) when fallback-on-error has a malformed value', async () => {
    core.getBooleanInput.mockImplementation(() => {
      throw new Error('TypeError: Input does not meet YAML 1.2 "Core Schema" specification: fallback-on-error');
    });
    setInputs();

    await main();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('fallback-on-error'));
  });

  it('does not fail the step when the summary write fails on the success path', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs();
    core.summary.write.mockRejectedValue(new Error('ENOENT: no summary file'));
    mockGetJson.mockResolvedValue({ statusCode: 200, result: { runners: [] } });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to write job summary'));
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });

  it('does not fail the step when the summary write fails on the fallback path', async () => {
    core.getBooleanInput.mockReturnValue(true);
    setInputs();
    core.summary.write.mockRejectedValue(new Error('ENOENT: no summary file'));
    mockGetJson.mockRejectedValue(new HttpClientError('Internal Server Error', 500));

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to write job summary'));
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });

  it('splits a comma-separated fallback-runner on the error path just like the success path', async () => {
    core.getBooleanInput.mockReturnValue(true);
    setInputs({ 'fallback-runner': 'linux,x64' });
    mockGetJson.mockRejectedValue(new HttpClientError('Internal Server Error', 500));

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["linux","x64"]');
  });

  it('trims whitespace from a comma-separated fallback-runner on the error path just like the success path', async () => {
    core.getBooleanInput.mockReturnValue(true);
    setInputs({ 'fallback-runner': 'linux, x64' });
    mockGetJson.mockRejectedValue(new HttpClientError('Internal Server Error', 500));

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["linux","x64"]');
  });

  it('falls back cleanly (exit 0) when getJson resolves with a non-200 statusCode (404, the statusCode source)', async () => {
    core.getBooleanInput.mockReturnValue(true);
    setInputs();
    mockGetJson.mockResolvedValue({ statusCode: 404, result: null });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });

  it.each([401, 403, 500, 503])(
    'falls back cleanly (exit 0) when getJson rejects with an HttpClientError (status %i, the throw source)',
    async (statusCode) => {
      core.getBooleanInput.mockReturnValue(true);
      setInputs();
      mockGetJson.mockRejectedValue(new HttpClientError('Bad credentials', statusCode));

      await main();

      expect(core.setFailed).not.toHaveBeenCalled();
      expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
    }
  );

  it('setFailed with a unified, readable error (status + GitHub detail) when fallback-on-error is false', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs();
    mockGetJson.mockRejectedValue(new HttpClientError('Bad credentials', 401));

    await main();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith('Failed to get runners. Status code: 401: Bad credentials');
  });

  it('never leaves an unhandled rejection when checkRunner itself throws', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs();
    mockGetJson.mockRejectedValue(new Error('network exploded'));

    await expect(main()).resolves.toBeUndefined();
    expect(core.setFailed).toHaveBeenCalledWith('Failed to get runners: network exploded');
  });

  it('formats a transport-level rejection (no statusCode, e.g. DNS/TLS failure) without a bogus status code', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs();
    mockGetJson.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));

    await main();

    expect(core.setFailed).toHaveBeenCalledWith(
      'Failed to get runners: getaddrinfo ENOTFOUND api.github.com'
    );
  });

  it('emits the primary runner on the success path when it is online', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs();
    mockGetJson.mockResolvedValue({
      statusCode: 200,
      result: {
        runners: [
          {
            status: 'online',
            busy: false,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
        ],
      },
    });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["self-hosted","linux"]');
  });

  it('builds the organization apiPath when organization is provided', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ organization: 'my-org' });
    mockGetJson.mockResolvedValue({ statusCode: 200, result: { runners: [] } });

    await main();

    expect(mockGetJson).toHaveBeenCalledWith(
      'https://api.github.com/orgs/my-org/actions/runners',
      expect.anything()
    );
  });

  it('builds the enterprise apiPath when enterprise is provided', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ enterprise: 'my-enterprise' });
    mockGetJson.mockResolvedValue({ statusCode: 200, result: { runners: [] } });

    await main();

    expect(mockGetJson).toHaveBeenCalledWith(
      'https://api.github.com/enterprises/my-enterprise/actions/runners',
      expect.anything()
    );
  });

  it('falls back cleanly when github-token is missing and fallback-on-error is true', async () => {
    core.getBooleanInput.mockReturnValue(true);
    setInputs({ 'github-token': '' });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });

  it('setFailed cleanly when github-token is missing and fallback-on-error is false', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ 'github-token': '' });

    await main();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('github-token'));
  });

  it('masks the github-token immediately, regardless of where it came from', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ 'github-token': 'literal-token-value' });
    mockGetJson.mockResolvedValue({ statusCode: 200, result: { runners: [] } });

    await main();

    expect(core.setSecret).toHaveBeenCalledWith('literal-token-value');
  });

  it('trims whitespace from a comma-separated primary-runner on the success path', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ 'primary-runner': 'self-hosted, linux' });
    mockGetJson.mockResolvedValue({
      statusCode: 200,
      result: {
        runners: [
          {
            status: 'online',
            busy: false,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
        ],
      },
    });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["self-hosted","linux"]');
  });

  it.each([
    ['../../zen', 'organization'],
    ['org/with/slashes', 'organization'],
    ['-leading-hyphen', 'organization'],
    ['trailing-hyphen-', 'organization'],
  ])('setFailed cleanly when organization is not a valid GitHub name (%s)', async (badValue) => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ organization: badValue });

    await main();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Invalid organization'));
  });

  it('setFailed cleanly when enterprise is not a valid GitHub name', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ enterprise: '../../zen' });

    await main();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Invalid enterprise'));
  });

  it('falls back cleanly when organization is invalid and fallback-on-error is true', async () => {
    core.getBooleanInput.mockReturnValue(true);
    setInputs({ organization: '../../zen' });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });

  it.each(['abc', '-1', '0', '1.5'])(
    'setFailed cleanly when primaries-required is not a positive integer (%s)',
    async (badValue) => {
      core.getBooleanInput.mockReturnValue(false);
      setInputs({ 'primaries-required': badValue });

      await main();

      expect(core.setOutput).not.toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('primaries-required'));
    }
  );

  it('uses an online primary even if busy when primaries-required is unset (production-shaped empty string input)', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ 'primaries-required': '' });
    mockGetJson.mockResolvedValue({
      statusCode: 200,
      result: {
        runners: [
          {
            status: 'online',
            busy: true,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
        ],
      },
    });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["self-hosted","linux"]');
  });

  it('respects primaries-required when set as the string core.getInput actually returns', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs({ 'primaries-required': '2' });
    mockGetJson.mockResolvedValue({
      statusCode: 200,
      result: {
        runners: [
          {
            status: 'online',
            busy: false,
            labels: [
              { name: 'self-hosted' },
              { name: 'linux' },
            ],
          },
        ],
      },
    });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    // only one non-busy primary available but two are required, so it falls back
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });
});
