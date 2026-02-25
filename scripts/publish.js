#!/usr/bin/env node
'use strict';

/**
 * Refoss Energy Monitor — publish script
 *
 * Usage:  node scripts/publish.js [patch|minor|major]
 *
 * What it does:
 *  1. Prompts for changelog text
 *  2. Bumps the version in app.json + .homeycompose/app.json + package.json
 *  3. Prepends an entry to CHANGELOG.md
 *  4. Commits, tags, and pushes to git
 *  5. Runs `homey app publish`
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');

// ─── helpers ────────────────────────────────────────────────────────────────

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(ROOT, file), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function promptMultiline(question) {
  return new Promise((resolve) => {
    console.log(question);
    console.log('(Enter each bullet on its own line. Type END on a blank line when done.)\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const lines = [];
    rl.on('line', (line) => {
      if (line.trim().toUpperCase() === 'END') { rl.close(); return; }
      lines.push(line);
    });
    rl.on('close', () => resolve(lines.join('\n')));
  });
}

// ─── main ───────────────────────────────────────────────────────────────────

(async () => {
  // 1. Determine bump type
  const bumpType = (process.argv[2] || 'patch').toLowerCase();
  if (!['patch', 'minor', 'major'].includes(bumpType)) {
    console.error('Usage: node scripts/publish.js [patch|minor|major]');
    process.exit(1);
  }

  // 2. Check working tree is clean
  const status = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
  if (status) {
    console.error('\nWorking tree has uncommitted changes. Please commit or stash first.\n');
    console.error(status);
    process.exit(1);
  }

  // 3. Read current version
  const pkg = readJson('package.json');
  const oldVersion = pkg.version;
  const newVersion = bumpVersion(oldVersion, bumpType);

  console.log(`\nCurrent version : ${oldVersion}`);
  console.log(`New version     : ${newVersion} (${bumpType} bump)\n`);

  const confirmVersion = await prompt(`Proceed with version ${newVersion}? (y/N) `);
  if (confirmVersion.toLowerCase() !== 'y') {
    console.log('Aborted.');
    process.exit(0);
  }

  // 4. Collect changelog
  const changelog = await promptMultiline(`\nChangelog for v${newVersion}:`);
  if (!changelog.trim()) {
    console.error('Changelog cannot be empty.');
    process.exit(1);
  }

  // Format as bullet list
  const bullets = changelog
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => (l.startsWith('-') ? l : `- ${l}`))
    .join('\n');

  // 5. Bump versions in all files
  console.log('\nBumping versions...');

  const appJsonCompose = readJson('.homeycompose/app.json');
  appJsonCompose.version = newVersion;
  writeJson('.homeycompose/app.json', appJsonCompose);

  pkg.version = newVersion;
  writeJson('package.json', pkg);

  // Run homey compose to rebuild app.json
  run('homey app compose');

  // 6. Prepend CHANGELOG entry
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const existing = fs.readFileSync(changelogPath, 'utf8');
  const entry = `## ${newVersion} (${today()})\n\n${bullets}\n\n`;
  fs.writeFileSync(changelogPath, `# Changelog\n\n${entry}${existing.replace(/^# Changelog\n\n?/, '')}`, 'utf8');

  console.log('\nCHANGELOG.md updated.');

  // 7. Commit, tag, push
  console.log('\nCommitting...');
  run(`git add .homeycompose/app.json app.json package.json CHANGELOG.md`);
  run(`git commit -m "chore: release v${newVersion}"`);
  run(`git tag v${newVersion}`);
  run(`git push origin main --tags`);

  console.log(`\nTagged and pushed v${newVersion}.`);

  // 8. Publish to Homey App Store
  const confirmPublish = await prompt(`\nPublish v${newVersion} to Homey App Store now? (y/N) `);
  if (confirmPublish.toLowerCase() !== 'y') {
    console.log('Skipped publish. Run `homey app publish` manually when ready.');
    process.exit(0);
  }

  console.log('\nPublishing...');
  run('homey app publish');

  console.log(`\n✓ v${newVersion} published successfully!\n`);
})();
