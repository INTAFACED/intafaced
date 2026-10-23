/**
 * Temp-dir fixtures for truth-check.mjs. No network.
 * Run: node --test tooling/scripts/truth-check.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./truth-check.mjs', import.meta.url));

const CLEAN_AGENTS = `# Agents
The front end is React. Vue is history.
Move value only through packages/ledger-client.
Never bypass them.
On a 403 or 429 from GitHub, stop.
Then git worktree remove <path>. Never use --force.
Never run pnpm wt:rm, pnpm wt:gc:apply or orca worktree rm.
`;

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=truth-check@example.com', '-c', 'user.name=truth-check', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git failed');
}

function fixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'truth-check-'));
  mkdirSync(join(root, 'tooling/agent-protocol'), { recursive: true });
  mkdirSync(join(root, '.cursor/rules'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), CLEAN_AGENTS);
  writeFileSync(join(root, 'CLAUDE.md'), '# agent rules\n');
  writeFileSync(join(root, 'CONTRIBUTING.md'), 'Never run `pnpm wt:rm` or `pnpm wt:gc:apply`.\n');
  writeFileSync(join(root, 'README.md'), '# readme\n');
  writeFileSync(join(root, 'tooling/agent-protocol/AGENT_PROTOCOL.md'), '# protocol\n');
  writeFileSync(join(root, '.cursor/rules/inta.mdc'), '# rules\n');
  writeFileSync(join(root, 'docs/README.md'), '# docs\n- [Move me](MOVE-ME.md)\n');
  writeFileSync(join(root, 'docs/MOVE-ME.md'), 'kept\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  mutate?.(root);
  return root;
}

function run(root, env = {}) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function withRoot(mutate, check, env) {
  const root = fixture(mutate);
  try {
    check(run(root, env), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('clean fixture passes, including Vue as history and prohibited wt commands', () => {
  withRoot(null, (result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});

test('planted stale doc: exact stale phrases, an instructed command, and Vue as the current front end', () => {
  const plants = [
    ['Merge when done', /stale agent rule in AGENTS.md: Merge when done/],
    ['agents may merge their own pull requests', /stale agent rule in AGENTS.md: may merge their own/],
    ['git worktree remove --force', /stale agent rule in AGENTS.md: worktree remove --force/],
    ['Run pnpm wt:rm', /stale agent rule in AGENTS.md: pnpm wt:rm/],
    ['Run pnpm wt:gc:apply', /stale agent rule in AGENTS.md: wt:gc:apply/],
    ['The front end is Vue.', /stale agent rule in AGENTS.md: Vue as the current front end/],
  ];
  for (const [line, pattern] of plants) {
    withRoot(
      (root) => writeFileSync(join(root, 'AGENTS.md'), `${CLEAN_AGENTS}\n${line}\n`),
      (result) => {
        assert.equal(result.status, 1, line);
        assert.match(result.stderr, pattern, result.stderr);
      },
    );
  }
});

test('AGENTS.md lost a core rule', () => {
  withRoot(
    (root) => writeFileSync(join(root, 'AGENTS.md'), CLEAN_AGENTS.replace('Never bypass', 'Skip the gate')),
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /AGENTS.md lost a core rule: Never bypass/);
    },
  );
});

test('added archive file and unlisted markdown fail; a listed file and a move pass', () => {
  withRoot(
    (root) => {
      git(root, ['checkout', '-b', 'topic']);
      mkdirSync(join(root, 'docs/archive'), { recursive: true });
      writeFileSync(join(root, 'docs/archive/planted.md'), 'planted stale doc\n');
      git(root, ['add', 'docs/archive/planted.md']);
      git(root, ['commit', '-m', 'add archive']);
    },
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /archive only receives moves: docs\/archive\/planted.md was added/);
    },
  );

  withRoot(
    (root) => {
      git(root, ['checkout', '-b', 'topic']);
      writeFileSync(join(root, 'docs/PLANTED.md'), 'new\n');
      writeFileSync(join(root, 'ROOT-PLANTED.md'), 'new\n');
      git(root, ['add', 'docs/PLANTED.md', 'ROOT-PLANTED.md']);
      git(root, ['commit', '-m', 'add markdown']);
    },
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /new markdown is not listed in docs\/README.md: docs\/PLANTED.md/);
      assert.match(result.stderr, /new markdown is not listed in docs\/README.md: ROOT-PLANTED.md/);
    },
  );

  withRoot(
    (root) => {
      git(root, ['checkout', '-b', 'topic']);
      writeFileSync(join(root, 'docs/LISTED.md'), 'new\n');
      writeFileSync(join(root, 'docs/README.md'), '# docs\n- [Move me](MOVE-ME.md)\n- `LISTED.md`\n');
      git(root, ['add', 'docs/LISTED.md', 'docs/README.md']);
      git(root, ['commit', '-m', 'add listed']);
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
    },
  );

  withRoot(
    (root) => {
      git(root, ['checkout', '-b', 'topic']);
      mkdirSync(join(root, 'docs/archive'), { recursive: true });
      git(root, ['mv', 'docs/MOVE-ME.md', 'docs/archive/MOVE-ME.md']);
      git(root, ['commit', '-m', 'move into archive']);
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

function agentsLine(line) {
  return (root) => writeFileSync(join(root, 'AGENTS.md'), `${CLEAN_AGENTS}\n${line}\n`);
}

test('honest Vue lines pass; matching is case-insensitive', () => {
  for (const line of ['Vue was retired; the front end is React.', 'Vue (historical) lives in vendor/.', 'No Vue.']) {
    withRoot(agentsLine(line), (result) => assert.equal(result.status, 0, `${line}: ${result.stderr}`));
  }
  withRoot(agentsLine('merge when done'), (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stale agent rule in AGENTS.md: Merge when done/);
  });
});

test('a negation after the forbidden command does not excuse it; a Forbidden lead-in does', () => {
  withRoot(agentsLine('Clean up with pnpm wt:rm; never push to main'), (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stale agent rule in AGENTS.md: pnpm wt:rm \(line \d+\)/);
  });
  withRoot(agentsLine('Forbidden commands:\n- pnpm wt:rm\n- pnpm wt:gc:apply'), (result) => {
    assert.equal(result.status, 0, result.stderr);
  });
  withRoot(agentsLine('## Never\n\nUse pnpm wt:gc:apply'), (result) => assert.equal(result.status, 0, result.stderr));
  withRoot(agentsLine('Allowed:\n- pnpm wt:rm'), (result) => assert.equal(result.status, 1));
});

test('stale text already on base but not changed in this push passes', () => {
  withRoot(
    (root) => {
      writeFileSync(join(root, 'AGENTS.md'), `${CLEAN_AGENTS}\nMerge when done\n`);
      git(root, ['commit', '-am', 'bad base']);
      git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      git(root, ['checkout', '-b', 'topic']);
      writeFileSync(join(root, 'CLAUDE.md'), '# agent rules, edited\n');
      git(root, ['commit', '-am', 'unrelated edit']);
    },
    (result) => assert.equal(result.status, 0, result.stderr),
  );
});

test('docs/README.md must link or backtick the file; DATA.md does not list A.md', () => {
  withRoot(
    (root) => {
      git(root, ['checkout', '-b', 'topic']);
      writeFileSync(join(root, 'docs/A.md'), 'new\n');
      writeFileSync(join(root, 'docs/DATA.md'), 'new\n');
      writeFileSync(join(root, 'docs/README.md'), '# docs\n- [Move me](MOVE-ME.md)\n- [Data](DATA.md)\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'add']);
    },
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not listed in docs\/README.md: docs\/A.md/);
      assert.doesNotMatch(result.stderr, /docs\/DATA.md/);
    },
  );
});

test('a move into archive passes even with diff.renames=false; archive README is allowed', () => {
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.renames', GIT_CONFIG_VALUE_0: 'false' };
  withRoot(
    (root) => {
      git(root, ['checkout', '-b', 'topic']);
      mkdirSync(join(root, 'docs/archive'), { recursive: true });
      git(root, ['mv', 'docs/MOVE-ME.md', 'docs/archive/MOVE-ME.md']);
      writeFileSync(join(root, 'docs/archive/README.md'), 'Archive index\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'move into archive']);
    },
    (result) => assert.equal(result.status, 0, result.stderr),
    env,
  );
});

test('a markdown link in AGENTS.md or docs/ARCHITECTURE.md to a missing repo path fails; real links, anchors, urls and code samples pass', () => {
  withRoot(agentsLine('See [the tool doc](docs/tooling/evidence-merge-check.md).'), (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dead link in AGENTS.md \(line \d+\): docs\/tooling\/evidence-merge-check.md/);
  });
  withRoot(
    (root) => {
      writeFileSync(join(root, 'docs/ARCHITECTURE.md'), '# arch\n\nSee [ops](../tooling/missing.md#part).\n');
    },
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /dead link in docs\/ARCHITECTURE.md \(line 3\): \.\.\/tooling\/missing.md/);
    },
  );
  withRoot(
    (root) => {
      writeFileSync(join(root, 'docs/ARCHITECTURE.md'), '# arch\n\n[Docs](README.md#top) and [Agents](../AGENTS.md).\n');
      writeFileSync(
        join(root, 'AGENTS.md'),
        `${CLEAN_AGENTS}\n[site](https://example.com/x.md) [mail](mailto:a@example.com) [here](#top)\n\`[no](docs/none.md)\`\n\`\`\`\n[no](docs/none.md)\n\`\`\`\n`,
      );
    },
    (result) => assert.equal(result.status, 0, result.stderr),
  );
});

test('an unbannered doc under docs/ with a stale rule fails; a bannered one, adr, runbooks, refs and archive pass', () => {
  const stale = '# Old law\n\nMerge when done. Run pnpm wt:rm.\n';
  withRoot(
    (root) => writeFileSync(join(root, 'docs/OLD-LAW.md'), stale),
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /stale rule in unbannered doc docs\/OLD-LAW.md: Merge when done/);
      assert.match(result.stderr, /stale rule in unbannered doc docs\/OLD-LAW.md: pnpm wt:rm \(line 3\)/);
    },
  );
  withRoot(
    (root) => {
      mkdirSync(join(root, 'docs/ops'), { recursive: true });
      writeFileSync(join(root, 'docs/ops/NESTED.md'), '# Nested\n\nThe front end is Vue.\n');
    },
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /stale rule in unbannered doc docs\/ops\/NESTED.md: Vue as the current front end/);
    },
  );
  withRoot(
    (root) => {
      const banner = '> **Not current rules (2026-10-17).** Current rules: [`AGENTS.md`](../AGENTS.md).\n\n';
      writeFileSync(join(root, 'docs/OLD-LAW.md'), `# Old law\n\n${banner}Merge when done.\n`);
      for (const dir of ['adr', 'runbooks', 'refs/x', 'archive']) {
        mkdirSync(join(root, 'docs', dir), { recursive: true });
        writeFileSync(join(root, 'docs', dir, 'DOC.md'), stale);
      }
    },
    (result) => assert.equal(result.status, 0, result.stderr),
  );
});

test('docs/ARCHITECTURE.md is current truth: a stale rule in it fails even though it has no banner', () => {
  withRoot(
    (root) => writeFileSync(join(root, 'docs/ARCHITECTURE.md'), '# arch\n\nRun pnpm wt:gc:apply.\n'),
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /stale rule in docs\/ARCHITECTURE.md: wt:gc:apply \(line 3\)/);
    },
  );
});

test('paraphrases of "merge your own PR" fail; the same words after a negation pass', () => {
  for (const line of ['You can merge your own PR.', 'Agents may merge when green.', 'Authors merge their own work.']) {
    withRoot(agentsLine(line), (result) => {
      assert.equal(result.status, 1, line);
      assert.match(result.stderr, /stale agent rule in AGENTS.md: (merge your own PR|may merge)/, line);
    });
    withRoot(
      (root) => writeFileSync(join(root, 'docs/OLD-LAW.md'), `# Old\n\n${line}\n`),
      (result) => {
        assert.equal(result.status, 1, line);
        assert.match(result.stderr, /stale rule in unbannered doc docs\/OLD-LAW.md/, line);
      },
    );
  }
  for (const line of ['Never merge your own PR.', 'Nobody does this: do not merge their own work.', 'No one may merge without review.']) {
    withRoot(agentsLine(line), (result) => assert.equal(result.status, 0, `${line}: ${result.stderr}`));
  }
});

test('a newly listed live doc that calls Vue the front end fails; a bannered or honest one passes', () => {
  const topic =
    (body, banner = '') =>
    (root) => {
      git(root, ['checkout', '-b', 'topic']);
      writeFileSync(join(root, 'docs/NEW-LIVE.md'), `# New live doc\n\n${banner}${body}\n`);
      writeFileSync(join(root, 'docs/README.md'), '# docs\n- [Move me](MOVE-ME.md)\n- [New](NEW-LIVE.md)\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'add listed doc']);
    };
  withRoot(topic('The product front end is Vue.'), (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stale rule in unbannered doc docs\/NEW-LIVE.md: Vue as the current front end/);
  });
  withRoot(topic('The front end is Vue.', '> **Not current rules (2026-10-17).** AGENTS.md wins.\n\n'), (result) => {
    assert.equal(result.status, 0, result.stderr);
  });
  withRoot(topic('Vue was retired; the front end is React.'), (result) => assert.equal(result.status, 0, result.stderr));
});

test('a negation elsewhere on the line does not excuse an instruction; only the words just before it do', () => {
  const loopholes = [
    'No review needed: you may merge your own PR once CI is green.',
    'Not sure who merges? Merge your own PR.',
    'Do not wait for review; merge your own PR.',
    'If no one objects within an hour, run pnpm wt:gc:apply.',
  ];
  for (const line of loopholes) {
    withRoot(agentsLine(line), (result) => {
      assert.equal(result.status, 1, line);
      assert.match(result.stderr, /stale agent rule in AGENTS.md: (merge your own PR|wt:gc:apply)/, line);
    });
  }
  const legitimate = [
    'Forbidden: `pnpm wt:rm`, `wt:gc:apply`',
    'Never: pnpm wt:rm',
    'Do not run pnpm wt:rm or git worktree remove --force',
    'Never run pnpm wt:rm, pnpm wt:gc:apply or orca worktree rm.',
    'Nobody does this: do not merge their own work.',
  ];
  for (const line of legitimate) {
    withRoot(agentsLine(line), (result) => assert.equal(result.status, 0, `${line}: ${result.stderr}`));
  }
});

test('"merge on green", "self-merge" and "merge it yourself" fail unless negated just before', () => {
  const plants = [
    ['Agents can merge on green.', 'merge on green'],
    ['Self-merge is fine.', 'self-merge'],
    ['Merge it yourself.', 'merge it yourself'],
  ];
  for (const [line, label] of plants) {
    withRoot(agentsLine(line), (result) => {
      assert.equal(result.status, 1, line);
      assert.match(result.stderr, new RegExp(`stale agent rule in AGENTS.md: ${label}`), line);
    });
  }
  for (const line of ['Never merge on green alone.', 'Do not self-merge.', 'Never merge it yourself.']) {
    withRoot(agentsLine(line), (result) => assert.equal(result.status, 0, `${line}: ${result.stderr}`));
  }
});

test('a banner must open the quote: a blockquote that only mentions history does not count', () => {
  const body = 'The front end is Vue.\n';
  withRoot(
    (root) => writeFileSync(join(root, 'docs/OLD.md'), `# Old\n\n> **Status: BINDING.** This replaces the history file.\n\n${body}`),
    (result) => {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /stale rule in unbannered doc docs\/OLD.md: Vue as the current front end/);
    },
  );
  withRoot(
    (root) =>
      writeFileSync(
        join(root, 'docs/OLD.md'),
        `# Old\n\n> **Supersession (2026-08-09):** thrift is void. Historical text below may mention it.\n\n${body}`,
      ),
    (result) => assert.equal(result.status, 1, result.stderr),
  );
  for (const opener of [
    '> **Not current rules (2026-10-18).** Kept as history.',
    '> **SUPERSEDED 2026-08-07.**',
    '> Historical record only.',
    '> **Stale snapshot.**',
    '> Retired.',
  ]) {
    withRoot(
      (root) => writeFileSync(join(root, 'docs/OLD.md'), `${opener}\n\n# Old\n\n${body}`),
      (result) => assert.equal(result.status, 0, `${opener}: ${result.stderr}`),
    );
  }
});
