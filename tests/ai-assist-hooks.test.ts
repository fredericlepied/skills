import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Build postInstall/postUninstall functions that operate on a given configDir,
 * matching the logic in agents.ts but decoupled from the module-level aiAssistHome.
 */
function buildHooks(configDir: string) {
  const postInstall = async (info: {
    skillName: string;
    skillDescription?: string;
    installPath: string;
    source: string;
    sourceType: string;
    ref?: string;
  }) => {
    const registryFile = join(configDir, 'installed-skills.json');
    let data: { skills: Array<Record<string, string>> } = { skills: [] };
    try {
      const content = await readFile(registryFile, 'utf-8');
      data = JSON.parse(content);
    } catch {}
    data.skills = data.skills.filter((s) => s.name !== info.skillName);
    data.skills.push({
      name: info.skillName,
      source: info.source,
      source_type: info.sourceType === 'github' ? 'git' : info.sourceType,
      branch: info.ref || 'main',
      installed_at: new Date().toISOString(),
      cache_path: info.installPath,
    });
    await mkdir(configDir, { recursive: true });
    await writeFile(registryFile, JSON.stringify(data, null, 2));
  };

  const postUninstall = async (info: {
    skillName: string;
    installPath: string;
    global: boolean;
  }) => {
    const registryFile = join(configDir, 'installed-skills.json');
    try {
      const content = await readFile(registryFile, 'utf-8');
      const data = JSON.parse(content);
      data.skills = (data.skills || []).filter(
        (s: Record<string, string>) => s.name !== info.skillName
      );
      await writeFile(registryFile, JSON.stringify(data, null, 2));
    } catch {}
  };

  return { postInstall, postUninstall };
}

async function setupConfigDir(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ai-assist-hooks-'));
  const configDir = join(root, '.ai-assist');
  await mkdir(configDir, { recursive: true });
  return { root, configDir };
}

describe('ai-assist postInstall hook', () => {
  it('creates installed-skills.json with skill entry', async () => {
    const { root, configDir } = await setupConfigDir();
    const registryFile = join(configDir, 'installed-skills.json');
    const installPath = join(root, '.agents/skills/test-skill');
    const { postInstall } = buildHooks(configDir);

    try {
      await postInstall({
        skillName: 'test-skill',
        skillDescription: 'A test skill',
        installPath,
        source: 'owner/repo/skills/test-skill',
        sourceType: 'github',
        ref: 'main',
      });

      const content = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(content.skills).toHaveLength(1);
      expect(content.skills[0].name).toBe('test-skill');
      expect(content.skills[0].source).toBe('owner/repo/skills/test-skill');
      expect(content.skills[0].source_type).toBe('git');
      expect(content.skills[0].branch).toBe('main');
      expect(content.skills[0].cache_path).toBe(installPath);
      expect(content.skills[0].installed_at).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replaces existing entry with same name (idempotent)', async () => {
    const { root, configDir } = await setupConfigDir();
    const registryFile = join(configDir, 'installed-skills.json');
    const { postInstall } = buildHooks(configDir);

    try {
      await writeFile(
        registryFile,
        JSON.stringify({
          skills: [
            {
              name: 'test-skill',
              source: 'old/source',
              source_type: 'local',
              branch: 'old',
              installed_at: '2025-01-01T00:00:00.000Z',
              cache_path: '/old/path',
            },
            {
              name: 'other-skill',
              source: 'other/source',
              source_type: 'git',
              branch: 'main',
              installed_at: '2025-01-01T00:00:00.000Z',
              cache_path: '/other/path',
            },
          ],
        })
      );

      await postInstall({
        skillName: 'test-skill',
        installPath: '/new/path',
        source: 'new/source',
        sourceType: 'git',
        ref: 'v2',
      });

      const content = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(content.skills).toHaveLength(2);

      const updated = content.skills.find((s: Record<string, string>) => s.name === 'test-skill');
      expect(updated.source).toBe('new/source');
      expect(updated.branch).toBe('v2');
      expect(updated.cache_path).toBe('/new/path');

      const other = content.skills.find((s: Record<string, string>) => s.name === 'other-skill');
      expect(other.source).toBe('other/source');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates config dir if it does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-assist-hooks-'));
    const configDir = join(root, '.ai-assist-new');
    const registryFile = join(configDir, 'installed-skills.json');
    const { postInstall } = buildHooks(configDir);

    try {
      await postInstall({
        skillName: 'new-skill',
        installPath: '/some/path',
        source: 'test',
        sourceType: 'local',
      });

      const content = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(content.skills).toHaveLength(1);
      expect(content.skills[0].name).toBe('new-skill');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps github sourceType to git', async () => {
    const { root, configDir } = await setupConfigDir();
    const registryFile = join(configDir, 'installed-skills.json');
    const { postInstall } = buildHooks(configDir);

    try {
      await postInstall({
        skillName: 'gh-skill',
        installPath: '/path',
        source: 'owner/repo',
        sourceType: 'github',
      });

      const content = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(content.skills[0].source_type).toBe('git');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defaults branch to main when ref is undefined', async () => {
    const { root, configDir } = await setupConfigDir();
    const registryFile = join(configDir, 'installed-skills.json');
    const { postInstall } = buildHooks(configDir);

    try {
      await postInstall({
        skillName: 'no-ref-skill',
        installPath: '/path',
        source: 'test',
        sourceType: 'local',
      });

      const content = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(content.skills[0].branch).toBe('main');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ai-assist postUninstall hook', () => {
  it('removes skill from installed-skills.json', async () => {
    const { root, configDir } = await setupConfigDir();
    const registryFile = join(configDir, 'installed-skills.json');
    const { postUninstall } = buildHooks(configDir);

    try {
      await writeFile(
        registryFile,
        JSON.stringify({
          skills: [
            {
              name: 'keep-skill',
              source: 'a',
              source_type: 'git',
              branch: 'main',
              installed_at: '2025-01-01T00:00:00.000Z',
              cache_path: '/a',
            },
            {
              name: 'remove-skill',
              source: 'b',
              source_type: 'git',
              branch: 'main',
              installed_at: '2025-01-01T00:00:00.000Z',
              cache_path: '/b',
            },
          ],
        })
      );

      await postUninstall({ skillName: 'remove-skill', installPath: '/b', global: true });

      const content = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(content.skills).toHaveLength(1);
      expect(content.skills[0].name).toBe('keep-skill');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not throw when registry file does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-assist-hooks-'));
    const configDir = join(root, 'nonexistent');
    const { postUninstall } = buildHooks(configDir);

    try {
      await expect(
        postUninstall({ skillName: 'nonexistent-skill', installPath: '/x', global: false })
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not throw when skill is not in registry', async () => {
    const { root, configDir } = await setupConfigDir();
    const registryFile = join(configDir, 'installed-skills.json');
    const { postUninstall } = buildHooks(configDir);

    try {
      await writeFile(
        registryFile,
        JSON.stringify({
          skills: [
            {
              name: 'other-skill',
              source: 'x',
              source_type: 'git',
              branch: 'main',
              installed_at: '2025-01-01T00:00:00.000Z',
              cache_path: '/x',
            },
          ],
        })
      );

      await expect(
        postUninstall({ skillName: 'nonexistent-skill', installPath: '/x', global: false })
      ).resolves.toBeUndefined();

      const content = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(content.skills).toHaveLength(1);
      expect(content.skills[0].name).toBe('other-skill');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
