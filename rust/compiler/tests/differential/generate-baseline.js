'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const RUST_COMPILER_ROOT = path.resolve(__dirname, '../..');
const RAW_COMPILER_ROOT = path.resolve(RUST_COMPILER_ROOT, '../../raw/compiler');
const OUTPUT_FILE = path.join(RUST_COMPILER_ROOT, 'compat/baseline.json');

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  };
}

function toPosixRel(base, target) {
  return path.relative(base, target).replace(/\\/g, '/');
}

function collectPackageFiles(pkgDir) {
  const results = {};
  const ignoreDirs = new Set([
    'node_modules',
    'temp',
    'output',
    'output-es2015',
  ]);
  const ignoreFiles = new Set(['tsconfig.tsbuildinfo']);

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (ignoreFiles.has(entry.name)) continue;
        const rel = toPosixRel(pkgDir, fullPath);
        results[rel] = sha256File(fullPath);
      }
    }
  }

  // Record top-level and key directories (src, lib, runtime, support, scripts, test/__snapshots__, test/*.js)
  const topEntries = fs.readdirSync(pkgDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of topEntries) {
    const fullPath = path.join(pkgDir, entry.name);
    if (entry.isFile()) {
      if (ignoreFiles.has(entry.name)) continue;
      results[entry.name] = sha256File(fullPath);
    } else if (entry.isDirectory()) {
      if (['lib', 'src', 'support'].includes(entry.name)) {
        walk(fullPath);
      } else if (entry.name === 'test') {
        // Record test/*.js and test/__snapshots__/*.snap and nested *.test.js
        const walkTest = (tDir) => {
          const tEntries = fs.readdirSync(tDir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
          );
          for (const te of tEntries) {
            const tf = path.join(tDir, te.name);
            if (te.isDirectory()) {
              if (ignoreDirs.has(te.name)) continue;
              walkTest(tf);
            } else if (
              te.isFile() &&
              (te.name.endsWith('.test.js') ||
                te.name === 'run-utils.js' ||
                te.name === 'custom-filters.js' ||
                te.name.endsWith('.snap'))
            ) {
              const rel = toPosixRel(pkgDir, tf);
              results[rel] = sha256File(tf);
            }
          }
        };
        walkTest(fullPath);
      }
    }
  }
  return results;
}

function getResolvedDepVersion(depName) {
  const pkgJsonPath = path.join(RAW_COMPILER_ROOT, 'node_modules', depName, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    return pkg.version;
  }
  return null;
}

function main() {
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(RAW_COMPILER_ROOT, 'package.json'), 'utf8')
  );
  const packagesDir = path.join(RAW_COMPILER_ROOT, 'packages');
  const packageDirs = fs
    .readdirSync(packagesDir)
    .filter((d) => fs.statSync(path.join(packagesDir, d)).isDirectory())
    .sort();

  const packages = {};
  for (const dirName of packageDirs) {
    const pkgDir = path.join(packagesDir, dirName);
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')
    );
    packages[pkgJson.name] = {
      version: pkgJson.version,
      path: `packages/${dirName}`,
      main: pkgJson.main || 'index.js',
      dependencies: pkgJson.dependencies || {},
      devDependencies: pkgJson.devDependencies || {},
      files: collectPackageFiles(pkgDir),
    };
  }

  const keyDependencies = [
    'character-parser',
    'is-expression',
    'constantinople',
    'with',
    'doctypes',
    'void-elements',
    'js-stringify',
    'token-stream',
    'jstransformer',
    'resolve',
    'object-assign',
    'uglify-js',
    'prettier',
    'jest',
    'typescript',
    'acorn',
    'acorn-walk',
    '@babel/parser',
    '@babel/types',
    'babel-walk',
    'line-json',
  ];
  const resolvedDependencies = {};
  for (const dep of keyDependencies) {
    resolvedDependencies[dep] = getResolvedDepVersion(dep);
  }

  const rootFiles = {
    'package.json': sha256File(path.join(RAW_COMPILER_ROOT, 'package.json')),
    'yarn.lock': sha256File(path.join(RAW_COMPILER_ROOT, 'yarn.lock')),
    'tsconfig.json': sha256File(path.join(RAW_COMPILER_ROOT, 'tsconfig.json')),
    'scripts/prebuild.js': sha256File(
      path.join(RAW_COMPILER_ROOT, 'scripts/prebuild.js')
    ),
    'scripts/filename-serializer.js': sha256File(
      path.join(RAW_COMPILER_ROOT, 'scripts/filename-serializer.js')
    ),
    'scripts/prettier-javascript-serializer.js': sha256File(
      path.join(RAW_COMPILER_ROOT, 'scripts/prettier-javascript-serializer.js')
    ),
    'scripts/buffer-serializer.js': sha256File(
      path.join(RAW_COMPILER_ROOT, 'scripts/buffer-serializer.js')
    ),
  };

  const rustcVersion = execSync('rustc --version', { encoding: 'utf8' }).trim();
  const cargoVersion = execSync('cargo --version', { encoding: 'utf8' }).trim();
  const nodeVersion = process.version;
  const yarnVersion = execSync('yarn --version', { encoding: 'utf8' }).trim();

  const baseline = {
    schemaVersion: 1,
    baselineRoot: '../../raw/compiler',
    monorepoName: rootPkg.name,
    lockedToolchain: {
      rust: {
        channel: '1.99.1',
        rustc: rustcVersion,
        cargo: cargoVersion,
        target: 'x86_64-pc-windows-msvc',
      },
      crates: {
        oxc: '0.157.0',
        napi: '3.16.1',
        'napi-derive': '3.7.0',
        'napi-build': '2.6.0',
      },
      node: {
        version: nodeVersion,
        engines: '>=20.0.0',
        yarn: yarnVersion,
        platform: process.platform,
        arch: process.arch,
      },
    },
    rootFiles,
    resolvedDependencies,
    packages,
    baselineTestSummary: {
      command: 'yarn build && yarn test',
      testSuitesTotal: 27,
      testSuitesPassed: 26,
      testSuitesWithApprovedEnvDiff: 1,
      testsTotal: 650,
      testsPassed: 648,
      testsWithApprovedEnvDiff: 2,
      snapshotsTotal: 326,
      snapshotsPassed: 326,
      approvedDiffIds: ['NODE16_V8_TYPEERROR_NULL_UNDEFINED_PROPERTY'],
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  console.log(`Generated ${OUTPUT_FILE} (${Object.keys(packages).length} packages recorded).`);
}

main();
