function normalizeStructuredContent(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function structuredResponse<T>(value: T) {
  const structuredContent = normalizeStructuredContent(value);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

export function resourceResponse(uri: string, value: unknown, mimeType = 'application/json') {
  return {
    contents: [
      {
        uri,
        mimeType,
        text:
          mimeType === 'application/json'
            ? `${JSON.stringify(value, null, 2)}\n`
            : typeof value === 'string'
              ? value
              : String(value),
      },
    ],
  };
}
