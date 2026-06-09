import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function writeFileSafe(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getProjectRoot(startDir?: string): Promise<string> {
  let dir = startDir ?? process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (
      (await fileExists(path.join(dir, '.git'))) ||
      (await fileExists(path.join(dir, 'package.json')))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return startDir ?? process.cwd();
}

export async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  const content = await readFileSafe(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );

  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeTextAtomic(filePath, content);
}

export async function readYamlSafe<T>(filePath: string): Promise<T | null> {
  const content = await readFileSafe(filePath);
  if (!content) return null;

  try {
    return YAML.parse(content) as T;
  } catch {
    return null;
  }
}

export async function writeYamlAtomic(filePath: string, value: unknown): Promise<void> {
  const content = YAML.stringify(value);
  await writeTextAtomic(filePath, content);
}

export async function copyFileSafe(sourcePath: string, destinationPath: string): Promise<void> {
  await ensureDir(path.dirname(destinationPath));
  await fs.copyFile(sourcePath, destinationPath);
}

export async function copyPathSafe(sourcePath: string, destinationPath: string): Promise<void> {
  await ensureDir(path.dirname(destinationPath));
  await fs.cp(sourcePath, destinationPath, {
    force: true,
    recursive: true,
  });
}

export async function tryHardlinkOrCopy(
  sourcePath: string,
  destinationPath: string,
): Promise<'hardlink' | 'copy'> {
  await ensureDir(path.dirname(destinationPath));

  try {
    await fs.link(sourcePath, destinationPath);
    return 'hardlink';
  } catch {
    await fs.copyFile(sourcePath, destinationPath);
    return 'copy';
  }
}

export async function trySymlinkOrCopy(
  sourcePath: string,
  destinationPath: string,
): Promise<'symlink' | 'copy'> {
  await ensureDir(path.dirname(destinationPath));

  try {
    await fs.symlink(sourcePath, destinationPath);
    return 'symlink';
  } catch {
    await fs.copyFile(sourcePath, destinationPath);
    return 'copy';
  }
}

export function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').trim();
  if (!normalized) {
    return '.';
  }

  const withoutCurrentDir = normalized.replace(/^\.\//, '');
  const collapsed = withoutCurrentDir.replace(/\/{2,}/g, '/');
  const result = path.posix.normalize(collapsed);

  if (result === '') {
    return '.';
  }

  return result.replace(/^\.\//, '');
}
