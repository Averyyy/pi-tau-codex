export function filterSlashCommands(commands, query) {
  const matches = commands.filter((command) => {
    const name = String(command.name || '').toLowerCase();
    const description = String(command.description || '').toLowerCase();
    return !query || name.includes(query) || description.includes(query);
  });
  if (!query) return matches;
  return [
    ...matches.filter((command) => String(command.name || '').toLowerCase() === query),
    ...matches.filter((command) => String(command.name || '').toLowerCase() !== query),
  ];
}
