/**
 * Build the site and publish it to the `gh-pages` branch.
 *
 * Usage: npm run deploy [-- --no-push] [-- --branch <name>]
 *
 * The working tree must be clean, so the deploy matches a real commit. The
 * deploy commit's message is the source commit's subject plus a UTC timestamp,
 * with the source SHA in the body. The branch only ever holds the built site;
 * each deploy is one commit on top of the previous one.
 *
 * Point GitHub Pages at the branch once: Settings → Pages → "Deploy from a
 * branch" → gh-pages, / (root).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const push = !args.includes('--no-push');
const branchFlag = args.indexOf('--branch');
const branch = branchFlag >= 0 ? args[branchFlag + 1] : 'gh-pages';
const remote = 'origin';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(root, process.env.OUT_DIR ?? 'dist');

const git = (argv, opts = {}) =>
  (execFileSync('git', argv, { cwd: root, encoding: 'utf8', ...opts }) ?? '').trim();
const tryGit = (argv, opts) => {
  try {
    return git(argv, { stdio: ['ignore', 'pipe', 'ignore'], ...opts });
  } catch {
    return null;
  }
};

if (git(['status', '--porcelain'])) {
  console.error('Working tree has uncommitted changes. Commit or stash them before deploying.');
  process.exit(1);
}

const sha = git(['rev-parse', 'HEAD']);
const subject = git(['log', '-1', '--format=%s']);
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

console.log(`Building ${sha.slice(0, 7)}: ${subject}`);
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

// GitHub Pages runs Jekyll by default, which drops `_astro/` (underscore dirs).
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
// A custom domain needs a CNAME file at the root of the published branch.
const site = new URL(process.env.SITE_URL ?? 'https://slideshow.photos');
if (!site.hostname.endsWith('.github.io')) {
  fs.writeFileSync(path.join(outDir, 'CNAME'), `${site.hostname}\n`);
}

const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-pages-'));
try {
  tryGit(['fetch', remote, branch], { stdio: 'inherit' });
  if (tryGit(['rev-parse', '--verify', `refs/remotes/${remote}/${branch}`])) {
    git(['worktree', 'add', '-B', branch, worktree, `${remote}/${branch}`]);
  } else if (tryGit(['rev-parse', '--verify', `refs/heads/${branch}`])) {
    git(['worktree', 'add', worktree, branch]);
  } else {
    git(['worktree', 'add', '--detach', worktree]);
    git(['checkout', '--orphan', branch], { cwd: worktree });
  }

  // Replace the branch contents with the fresh build.
  for (const entry of fs.readdirSync(worktree)) {
    if (entry !== '.git') fs.rmSync(path.join(worktree, entry), { recursive: true, force: true });
  }
  fs.cpSync(outDir, worktree, { recursive: true });

  git(['add', '--all'], { cwd: worktree });
  // `diff --quiet` exits non-zero when there are changes; a fresh orphan branch always commits.
  const unchanged =
    tryGit(['rev-parse', '--verify', 'HEAD'], { cwd: worktree }) !== null &&
    tryGit(['diff', '--cached', '--quiet'], { cwd: worktree }) !== null;
  if (unchanged) {
    console.log(`No changes to deploy; ${branch} already matches this build.`);
  } else {
    git(['commit', '--quiet', '-m', `${subject} (${timestamp})`, '-m', `Built from ${sha}`], {
      cwd: worktree,
    });
    console.log(`Committed ${git(['rev-parse', '--short', 'HEAD'], { cwd: worktree })} to ${branch}`);
  }

  if (push) {
    git(['push', remote, branch], { cwd: worktree, stdio: 'inherit' });
    console.log(`Pushed ${branch} to ${remote}.`);
  } else {
    console.log(`Skipped push. Run \`git push ${remote} ${branch}\` to publish.`);
  }
} finally {
  tryGit(['worktree', 'remove', '--force', worktree]);
  fs.rmSync(worktree, { recursive: true, force: true });
}
