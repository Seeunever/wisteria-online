import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';

const projectRoot = realpathSync(process.cwd());
const nextRoot = path.join(projectRoot, '.next');
const standaloneRoot = path.join(nextRoot, 'standalone');

function assertDirectory(directory) {
  if (!existsSync(directory)) throw new Error(`MISSING_BUILD_DIRECTORY:${path.basename(directory)}`);
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('UNSAFE_BUILD_DIRECTORY');
}

function assertInsideStandalone(target) {
  const relative = path.relative(standaloneRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('UNSAFE_STANDALONE_TARGET');
  }
}

function assertInsideProject(target) {
  const relative = path.relative(projectRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('UNSAFE_BUILD_LINK_TARGET');
  }
}

function materializeBuildLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const metadata = lstatSync(target);

    if (metadata.isSymbolicLink()) {
      const source = realpathSync(target);
      assertInsideProject(source);
      const replacement = `${target}.materializing-${process.pid}`;
      if (existsSync(replacement)) throw new Error('STALE_BUILD_LINK_REPLACEMENT');

      try {
        cpSync(source, replacement, {
          recursive: lstatSync(source).isDirectory(),
          dereference: true,
          errorOnExist: true,
          force: false,
        });
        rmSync(target, { recursive: true, force: false });
        renameSync(replacement, target);
      } finally {
        if (existsSync(replacement)) rmSync(replacement, { recursive: true, force: false });
      }
    }

    if (lstatSync(target).isDirectory()) materializeBuildLinks(target);
  }
}

function replaceBuildDirectory(source, destination) {
  assertDirectory(source);
  assertInsideStandalone(destination);
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: false });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
}

function copySharpRuntimeDependencies() {
  const sharpPackage = realpathSync(path.join(projectRoot, 'node_modules', 'sharp', 'package.json'));
  const sharpDependencyRoot = path.dirname(path.dirname(sharpPackage));
  const standaloneModules = path.join(standaloneRoot, 'node_modules');
  for (const dependency of ['@img', 'detect-libc', 'semver']) {
    const source = path.join(sharpDependencyRoot, dependency);
    if (!existsSync(source)) continue;
    const destination = path.join(standaloneModules, dependency);
    assertInsideStandalone(destination);
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: false });
    cpSync(source, destination, { recursive: true, dereference: true, errorOnExist: true, force: false });
  }
}

assertDirectory(nextRoot);
assertDirectory(standaloneRoot);
if (process.platform === 'win32') materializeBuildLinks(standaloneRoot);
copySharpRuntimeDependencies();
replaceBuildDirectory(path.join(nextRoot, 'static'), path.join(standaloneRoot, '.next', 'static'));
replaceBuildDirectory(path.join(projectRoot, 'public'), path.join(standaloneRoot, 'public'));
const tracedDataDirectory = path.join(standaloneRoot, '.data');
assertInsideStandalone(tracedDataDirectory);
if (existsSync(tracedDataDirectory)) {
  const metadata = lstatSync(tracedDataDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('UNSAFE_TRACED_DATA_DIRECTORY');
  }
  rmSync(tracedDataDirectory, { recursive: true, force: false });
}
process.stdout.write('Standalone static assets prepared.\n');
