import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  formatResourceCounts,
  packageActionWarning,
  packageProgressText,
  resourceCounts,
} from '../public/package-settings.js';

const source = await readFile(new URL('../public/package-settings.js', import.meta.url), 'utf8');

test('package rows count only their exact source and scope resources', () => {
  const resources = {
    extensions: [
      { source: 'npm:tools', scope: 'global' },
      { source: 'npm:tools', scope: 'project' },
    ],
    skills: [{ source: 'npm:tools', scope: 'global' }],
    prompts: [{ source: 'local', scope: 'global' }],
    themes: [],
  };
  const counts = resourceCounts(resources, 'npm:tools', 'global');
  assert.deepEqual(counts, { extensions: 1, skills: 1, prompts: 0, themes: 0 });
  assert.equal(formatResourceCounts(counts), '1 extensions · 1 skills · 0 prompts · 0 themes');
});

test('package mutations disclose code execution before using structured RPCs', () => {
  assert.equal(
    packageActionWarning('update', 'npm:tools'),
    'Update npm:tools? Package operations can execute code on this machine.',
  );
  assert.match(source, /confirmAction\(packageActionWarning\(action, source\)\)/);
  assert.match(source, /type: `\$\{action\}_pi_package`, source, scope/);
  assert.doesNotMatch(source, /setInterval|setTimeout/);
});

test('package progress uses Pi progress messages without polling', () => {
  assert.equal(packageProgressText({ message: 'Cloning repository' }), 'Cloning repository');
  assert.equal(
    packageProgressText({ action: 'install', source: 'npm:tools' }),
    'Install npm:tools',
  );
  assert.equal(packageProgressText({}), '');
});
