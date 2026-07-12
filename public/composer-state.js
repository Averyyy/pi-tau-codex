export function getComposerState({
  isMirrorMode,
  viewingActiveSession,
  isLaunchingNewSession,
  sessionClosed = false,
  previewingBranch = false,
}) {
  if (sessionClosed) {
    return { disabled: true, placeholder: 'Session closed', readOnly: true };
  }
  const readOnly = previewingBranch || (isMirrorMode && !viewingActiveSession);
  const disabled = readOnly || isLaunchingNewSession;
  const placeholder = isLaunchingNewSession
    ? 'Opening new session...'
    : previewingBranch
      ? 'Previewing branch (read-only)'
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
