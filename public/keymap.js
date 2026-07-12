const shortcut = (definition) => Object.freeze(definition);

export const WEB_KEYMAP = Object.freeze([
  shortcut({ id: 'commands.focus', scope: 'global', key: '/', label: 'Open commands', keys: '/' }),
  shortcut({ id: 'ui.dismiss', scope: 'global', key: 'Escape', label: 'Close panel or abort', keys: 'Escape' }),
  shortcut({ id: 'composer.send', scope: 'composer', key: 'Enter', label: 'Send message', keys: 'Enter' }),
  shortcut({ id: 'composer.newline', scope: 'composer', key: 'Enter', shift: true, label: 'Insert newline', keys: 'Shift + Enter' }),
  shortcut({ id: 'slash.previous', scope: 'slash', key: 'ArrowUp', label: 'Previous slash command', keys: 'Arrow Up' }),
  shortcut({ id: 'slash.next', scope: 'slash', key: 'ArrowDown', label: 'Next slash command', keys: 'Arrow Down' }),
  shortcut({ id: 'slash.choose', scope: 'slash', key: 'Tab', label: 'Choose slash command', keys: 'Tab' }),
  shortcut({ id: 'slash.choose-enter', scope: 'slash', key: 'Enter', label: 'Choose slash command', keys: 'Enter', hidden: true }),
  shortcut({ id: 'slash.dismiss', scope: 'slash', key: 'Escape', label: 'Close slash commands', keys: 'Escape', hidden: true }),
]);

export function matchShortcut(event, scope) {
  return WEB_KEYMAP.find((entry) => (
    entry.scope === scope
    && entry.key === event.key
    && Boolean(entry.shift) === Boolean(event.shiftKey)
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
  )) || null;
}

export function visibleShortcuts() {
  return WEB_KEYMAP.filter((entry) => !entry.hidden);
}
