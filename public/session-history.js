export function getSessionHistoryFallback(renderedCount, pendingUserMessage) {
  if (renderedCount > 0) return null;
  return pendingUserMessage ? 'pending-user' : 'welcome';
}
