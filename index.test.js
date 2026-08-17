const { checkRunner } = require('./index');
const mockGetJson = jest.fn();

jest.mock('@actions/http-client', () => {
  return {
    HttpClient: jest.fn().mockImplementation(() => {
      return {
        getJson: mockGetJson,
      };
    }),
    BearerCredentialHandler: jest.fn(),
  };
});

jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
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
    mockGetJson.mockResolvedValue({ statusCode: 500 });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to write job summary'));
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["ubuntu-latest"]');
  });

  it('splits a comma-separated fallback-runner on the error path just like the success path', async () => {
    core.getBooleanInput.mockReturnValue(true);
    setInputs({ 'fallback-runner': 'linux,x64' });
    mockGetJson.mockResolvedValue({ statusCode: 500 });

    await main();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('use-runner', '["linux","x64"]');
  });

  it('never leaves an unhandled rejection when checkRunner itself throws', async () => {
    core.getBooleanInput.mockReturnValue(false);
    setInputs();
    mockGetJson.mockRejectedValue(new Error('network exploded'));

    await expect(main()).resolves.toBeUndefined();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('network exploded'));
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
});
