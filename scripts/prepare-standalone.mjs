import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
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

function replaceBuildDirectory(source, destination) {
  assertDirectory(source);
  assertInsideStandalone(destination);
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: false });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
}

assertDirectory(nextRoot);
assertDirectory(standaloneRoot);
replaceBuildDirectory(path.join(nextRoot, 'static'), path.join(standaloneRoot, '.next', 'static'));
replaceBuildDirectory(path.join(projectRoot, 'public'), path.join(standaloneRoot, 'public'));
process.stdout.write('Standalone static assets prepared.\n');
