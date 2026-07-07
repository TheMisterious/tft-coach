const fs = require('fs');
const path = require('path');

async function copyDirectory(sourceDir, targetDir) {
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
  await fs.promises.mkdir(targetDir, { recursive: true });

  await Promise.all(entries.map(async (entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      return;
    }

    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.promises.readlink(sourcePath);
      await fs.promises.symlink(linkTarget, targetPath);
      return;
    }

    await fs.promises.copyFile(sourcePath, targetPath);
  }));
}

class OwWebpackPlugin {
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    compiler.hooks.afterEmit.tapPromise('OwWebpackPlugin', async () => {
      const { sourceDir, outputDir, dataDirs } = this.options;

      if (!sourceDir || !outputDir) {
        return;
      }

      await copyDirectory(sourceDir, outputDir);

      // Copy additional data directories (e.g. data/ → dist/data/)
      if (Array.isArray(dataDirs)) {
        for (const { from, to } of dataDirs) {
          await copyDirectory(from, to);
        }
      }

      if (this.options.packageDir) {
        await fs.promises.mkdir(this.options.packageDir, { recursive: true });
      }
    });
  }
}

module.exports = OwWebpackPlugin;