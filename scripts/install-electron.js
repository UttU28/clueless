#!/usr/bin/env node
const { downloadArtifact } = require('@electron/get');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const { version } = require(path.join(electronDir, 'package.json'));
const distDir = path.join(electronDir, 'dist');
const binary = path.join(distDir, process.platform === 'win32' ? 'electron.exe' : 'electron');

async function main() {
  if (fs.existsSync(binary) && fs.existsSync(path.join(electronDir, 'path.txt'))) {
    console.log('Electron OK:', binary);
    return;
  }
  console.log(`Downloading Electron ${version}...`);
  fs.mkdirSync(distDir, { recursive: true });
  const zip = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    checksums: require(path.join(electronDir, 'checksums.json')),
  });
  if (process.platform === 'win32') {
    require('extract-zip')(zip, { dir: distDir });
  } else {
    execFileSync('unzip', ['-o', '-q', zip, '-d', distDir], { stdio: 'inherit' });
  }
  fs.writeFileSync(path.join(electronDir, 'path.txt'), process.platform === 'win32' ? 'electron.exe' : 'electron');
  console.log('Electron ready:', binary);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
