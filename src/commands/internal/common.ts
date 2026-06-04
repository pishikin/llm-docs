import fs from 'node:fs/promises';
import { getProjectRoot } from '../../utils/fs.js';
import type { V2Runtime } from '../../v2/runtime.js';
import { createV2Runtime } from '../../v2/runtime.js';

export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

export async function readJsonStdin<T>(): Promise<T | null> {
  const raw = (await readStdinText()).trim();
  if (!raw) {
    return null;
  }

  return JSON.parse(raw) as T;
}

export function writeTextResponse(text: string): void {
  if (text.trim()) {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
}

export function writeJsonResponse(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function getRuntimeOrNull(startDir?: string): Promise<V2Runtime | null> {
  try {
    const projectRoot = await getProjectRoot(startDir);
    return await createV2Runtime(projectRoot, { createIfMissing: false });
  } catch {
    return null;
  }
}

export async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
