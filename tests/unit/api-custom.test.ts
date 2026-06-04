import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomProvider } from '../../src/providers/api-custom.js';

const ENV_VAR = 'TEST_CUSTOM_API_KEY';

function makeJsonResponse(content: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () =>
      Promise.resolve({
        choices: [{ message: { content } }],
      }),
    text: () => Promise.resolve(''),
  } as Response;
}

function makeErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(body),
  } as Response;
}

describe('CustomProvider', () => {
  beforeEach(() => {
    process.env[ENV_VAR] = 'test-key-123';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeJsonResponse('Generated docs'));
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
    vi.restoreAllMocks();
  });

  it('throws ConfigError when API key env var is not set', () => {
    delete process.env[ENV_VAR];
    expect(() => new CustomProvider('https://api.example.com/v1', ENV_VAR, 'model-1')).toThrow(
      'TEST_CUSTOM_API_KEY not set',
    );
  });

  it('sends correct request to the API', async () => {
    const provider = new CustomProvider('https://api.example.com/v1', ENV_VAR, 'model-1');
    const result = await provider.generate('user prompt', 'system prompt');

    expect(result).toBe('Generated docs');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key-123',
        },
        body: JSON.stringify({
          model: 'model-1',
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'user prompt' },
          ],
          max_tokens: 4096,
        }),
      }),
    );
  });

  it('strips trailing slashes from base URL', async () => {
    const provider = new CustomProvider('https://api.example.com/v1/', ENV_VAR, 'model-1');
    await provider.generate('prompt', 'system');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.anything(),
    );
  });

  it('omits system message when system prompt is empty', async () => {
    const provider = new CustomProvider('https://api.example.com/v1', ENV_VAR, 'model-1');
    await provider.generate('user prompt', '');

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'user prompt' }]);
  });

  it('throws ProviderError on HTTP error', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeErrorResponse(401, 'Unauthorized'));

    const provider = new CustomProvider('https://api.example.com/v1', ENV_VAR, 'model-1');
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('Custom API error (401)');
  });

  it('throws ProviderError on empty response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ choices: [] }),
      text: () => Promise.resolve(''),
    } as Response);

    const provider = new CustomProvider('https://api.example.com/v1', ENV_VAR, 'model-1');
    await expect(provider.generate('prompt', 'system')).rejects.toThrow(
      'empty or invalid response',
    );
  });

  it('throws ProviderError on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const provider = new CustomProvider('https://api.example.com/v1', ENV_VAR, 'model-1');
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('ECONNREFUSED');
  });

  it('throws ProviderError on timeout', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const provider = new CustomProvider('https://api.example.com/v1', ENV_VAR, 'model-1', {
      timeoutMs: 50,
    });
    await expect(provider.generate('prompt', 'system')).rejects.toThrow('timed out');
  });
});
