const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const pkg = require('../package.json');

// Zips the contents of sourceDir (not the folder itself — manifest.json must
// sit at the zip root for Overwolf to load it) into outPath, then renames
// .zip -> .opk. Overwolf's own packaging docs call for normal (not maximum)
// compression, hence zlib level 6 (the standard "default" level) rather than 9.
function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

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

        const zipPath = path.join(this.options.packageDir, `${pkg.name}-${pkg.version}.zip`);
        const opkPath = path.join(this.options.packageDir, `${pkg.name}-${pkg.version}.opk`);

        await zipDirectory(outputDir, zipPath);
        await fs.promises.rm(opkPath, { force: true });
        await fs.promises.rename(zipPath, opkPath);
      }
    });
  }
}

module.exports = OwWebpackPlugin;