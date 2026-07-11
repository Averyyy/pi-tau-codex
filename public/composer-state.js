export function getComposerState({ isMirrorMode, viewingActiveSession, isLaunchingNewSession }) {
  const readOnly = isMirrorMode && !viewingActiveSession;
  const disabled = readOnly || isLaunchingNewSession;
  const placeholder = isLaunchingNewSession
    ? 'Opening new session...'
    : readOnly
      ? 'Viewing historical session (read-only)'
      : 'Message...';

  return { disabled, placeholder, readOnly };
}
