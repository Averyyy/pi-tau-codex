import assert from 'node:assert/strict';
import test from 'node:test';

import { filterSlashCommands } from '../public/slash-command-filter.js';

test('exact command names precede description and substring matches without reordering either group', () => {
  const commands = [
    { name: 'export', description: 'Export the current session' },
    { name: 'session-info', description: 'Inspect a session' },
    { name: 'session', description: 'Show stats' },
    { name: 'resume', description: 'Resume a session' },
  ];

  assert.deepEqual(
    filterSlashCommands(commands, 'session').map((command) => command.name),
    ['session', 'export', 'session-info', 'resume'],
  );
  assert.deepEqual(filterSlashCommands(commands, '').map((command) => command.name), [
    'export',
    'session-info',
    'session',
    'resume',
  ]);
});
