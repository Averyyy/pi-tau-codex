export function getComposerState({ isMirrorMode, viewingActiveSession, isLaunchingNewSession, sessionClosed = false }) {
  if (sessionClosed) {
    return { disabled: true, placeholder: 'Session closed', readOnly: true };
  }
  const readOnly = isMirrorMode && !viewingActiveSession;
  const disabled = readOnly || isLaunchingNewSession;
  const placeholder = isLaunchingNewSession
    ? 'Opening new session...'
    : readOnly
      ? 'Viewing historical session (read-only)'
      : 'Message...';

  return { disabled, placeholder, readOnly };
}

export function disableSessionControls(root) {
  for (const control of root.querySelectorAll('button, input, textarea, select')) {
    control.disabled = true;
  }
}
