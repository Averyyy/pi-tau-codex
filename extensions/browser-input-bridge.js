export function sameBrowserInputOwner(left, right) {
  return !!left && !!right && left.client === right.client && left.leaseId === right.leaseId;
}

export function hasBrowserInputListener(listeners) {
  return listeners.size > 0;
}

export function dispatchBrowserInput(listeners, data) {
  let current = data;
  for (const record of listeners.values()) {
    const result = record.handler(current);
    if (result?.consume) return { consumed: true, data: current };
    if (result?.data !== undefined) current = result.data;
  }
  return { consumed: false, data: current };
}
