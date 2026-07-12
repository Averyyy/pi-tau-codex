function responseError(data, fallback) {
  return new Error(data?.error || data?.message || fallback);
}

async function readJsonResponse(response, fallback) {
  const data = await response.json();
  if (!response.ok) throw responseError(data, fallback);
  return data;
}

export function sessionActionTitle(session) {
  return session?.name || session?.firstMessage || 'Untitled session';
}

export function resolveSessionActionContext({
  session,
  currentSession,
  mirrorActiveSessionFile,
  viewingActiveSession,
  isNewSessionMode,
}) {
  if (isNewSessionMode && !session) return null;
  const selected = session || currentSession;
  const sessionFile = selected?.filePath || (viewingActiveSession ? mirrorActiveSessionFile : null);
  return {
    active: session
      ? Boolean(sessionFile && sessionFile === mirrorActiveSessionFile)
      : viewingActiveSession,
    sessionFile,
    name: selected?.name || null,
    firstMessage: selected?.firstMessage || null,
  };
}

export function actionTargetsDisplayedSession({
  sessionFile,
  active,
  currentSessionFile,
  viewingActiveSession,
}) {
  if (sessionFile) return sessionFile === currentSessionFile;
  return active && viewingActiveSession && !currentSessionFile;
}

export function attachmentFilename(disposition, fallback) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return disposition?.match(/filename="?([^";]+)"?/i)?.[1] || fallback;
}

export function downloadBlob(blob, filename, { documentRef = document, urlApi = URL } = {}) {
  const objectUrl = urlApi.createObjectURL(blob);
  const link = documentRef.createElement('a');
  try {
    link.href = objectUrl;
    link.download = filename;
    documentRef.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    urlApi.revokeObjectURL(objectUrl);
  }
}

export async function requestSessionInfo({ active, sessionFile, request, fetchImpl = fetch }) {
  if (active) {
    const response = await request({ type: 'get_session_stats' });
    return response.data;
  }
  const response = await fetchImpl(`/api/sessions/info?sessionFile=${encodeURIComponent(sessionFile)}`);
  return readJsonResponse(response, 'Failed to load session info');
}

export async function renameSession({ active, sessionFile, name, request, mutationFetch }) {
  if (typeof name !== 'string') throw new Error('Name must be a string');
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('Name cannot be empty');
  if (normalizedName.length > 200) throw new Error('Name cannot exceed 200 characters');
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(normalizedName)) {
    throw new Error('Name cannot contain control characters');
  }
  if (active) return request({ type: 'set_session_name', name: normalizedName });
  const response = await mutationFetch('/api/sessions/name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionFile, name: normalizedName }),
  });
  return readJsonResponse(response, 'Failed to rename session');
}

export async function exportSession({ format, sessionFile, mutationFetch }) {
  const body = sessionFile ? { format, sessionFile } : { format };
  const response = await mutationFetch('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw responseError(await response.json(), 'Failed to export session');
  return {
    blob: await response.blob(),
    filename: attachmentFilename(response.headers.get('Content-Disposition'), `session.${format}`),
  };
}

export function sessionInfoRows(info) {
  const rows = [
    ['Name', info.name],
    ['Session', info.sessionId],
    ['File', info.sessionFile || 'Not persisted'],
    ['Working directory', info.cwd],
    ['Messages', info.totalMessages],
    ['User messages', info.userMessages],
    ['Assistant messages', info.assistantMessages],
    ['Tool calls', info.toolCalls],
    ['Tool results', info.toolResults],
    ['Compactions', info.compactions],
    ['Branch points', info.branchPoints],
    ['Tokens total', info.tokens?.total],
    ['Tokens input', info.tokens?.input],
    ['Tokens output', info.tokens?.output],
    ['Cache read', info.tokens?.cacheRead],
    ['Cache write', info.tokens?.cacheWrite],
    ['Cost', typeof info.cost?.total === 'number' ? `$${info.cost.total.toFixed(4)}` : null],
    ['Model', info.model ? `${info.model.provider}/${info.model.id}` : null],
    ['Thinking', info.thinkingLevel],
    ['Context usage', info.contextUsage
      ? `${info.contextUsage.tokens === null ? 'Unknown' : info.contextUsage.tokens} / ${info.contextUsage.contextWindow}`
      : null],
    ['Parent', info.parentSession],
  ];
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
}

async function copyText(text, { clipboard, documentRef }) {
  if (clipboard?.writeText) return clipboard.writeText(text);
  const input = documentRef.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  documentRef.body.appendChild(input);
  input.select();
  const copied = documentRef.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Copy is unavailable in this browser');
}

export function createSessionActions({
  dialog,
  titleElement,
  bodyElement,
  statusElement,
  closeButton,
  mutationFetch,
  request,
  fetchImpl = fetch,
  onRenamed,
  documentRef = document,
  locationRef = location,
  clipboard = navigator.clipboard,
}) {
  let viewId = 0;

  function setStatus(message, error = false) {
    statusElement.textContent = message;
    statusElement.classList.toggle('error', error);
    statusElement.hidden = !message;
  }

  function open(title, mode) {
    viewId += 1;
    dialog.dataset.mode = mode;
    titleElement.textContent = title;
    bodyElement.replaceChildren();
    setStatus('');
    if (!dialog.open) dialog.showModal();
    return viewId;
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  function openPanel(title, mode) {
    const currentView = open(title, mode);
    return {
      body: bodyElement,
      close,
      isCurrent: () => currentView === viewId,
      setStatus: (message, error = false) => {
        if (currentView === viewId) setStatus(message, error);
      },
    };
  }

  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', () => { viewId += 1; });

  function openRename(session) {
    open('Rename session', 'rename');
    const form = documentRef.createElement('form');
    form.className = 'session-action-form';
    const label = documentRef.createElement('label');
    label.textContent = 'Session name';
    const input = documentRef.createElement('input');
    input.className = 'dialog-input';
    input.name = 'name';
    input.required = true;
    input.maxLength = 200;
    input.value = session?.name || '';
    input.setAttribute('aria-label', 'Session name');
    label.appendChild(input);
    const actions = documentRef.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = documentRef.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    const save = documentRef.createElement('button');
    save.type = 'submit';
    save.textContent = 'Rename';
    actions.append(cancel, save);
    form.append(label, actions);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      save.disabled = true;
      setStatus('Renaming...');
      try {
        await renameSession({ ...session, name, request, mutationFetch });
        await onRenamed({ ...session, name });
        close();
      } catch (error) {
        setStatus(error.message, true);
        save.disabled = false;
      }
    });
    bodyElement.appendChild(form);
    input.focus();
  }

  function openExport(session) {
    open('Export session', 'export');
    const form = documentRef.createElement('form');
    form.className = 'session-action-form';
    const choices = documentRef.createElement('fieldset');
    choices.className = 'format-segment';
    choices.setAttribute('aria-label', 'Export format');
    for (const [format, label] of [['html', 'HTML'], ['jsonl', 'JSONL']]) {
      const choice = documentRef.createElement('label');
      const radio = documentRef.createElement('input');
      radio.type = 'radio';
      radio.name = 'format';
      radio.value = format;
      radio.checked = format === 'html';
      choice.append(radio, label);
      choices.appendChild(choice);
    }
    const actions = documentRef.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = documentRef.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    const submit = documentRef.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Export';
    actions.append(cancel, submit);
    form.append(choices, actions);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      setStatus('Preparing export...');
      try {
        const format = new FormData(form).get('format');
        const result = await exportSession({ format, sessionFile: session.sessionFile, mutationFetch });
        downloadBlob(result.blob, result.filename, { documentRef });
        close();
      } catch (error) {
        setStatus(error.message, true);
        submit.disabled = false;
      }
    });
    bodyElement.appendChild(form);
  }

  async function openInfo(session) {
    const currentView = open('Session info', 'info');
    setStatus('Loading session info...');
    try {
      const info = await requestSessionInfo({ ...session, request, fetchImpl });
      if (currentView !== viewId) return;
      const list = documentRef.createElement('dl');
      list.className = 'session-info-list';
      for (const [label, value] of sessionInfoRows(info)) {
        const term = documentRef.createElement('dt');
        term.textContent = label;
        const detail = documentRef.createElement('dd');
        detail.textContent = typeof value === 'number' ? value.toLocaleString() : String(value);
        list.append(term, detail);
      }
      bodyElement.replaceChildren(list);
      setStatus('');
    } catch (error) {
      if (currentView === viewId) setStatus(error.message, true);
    }
  }

  function openHotkeys(shortcuts) {
    open('Keyboard shortcuts', 'hotkeys');
    const list = documentRef.createElement('dl');
    list.className = 'hotkey-list';
    for (const shortcut of shortcuts) {
      const term = documentRef.createElement('dt');
      term.textContent = shortcut.label;
      const detail = documentRef.createElement('dd');
      const key = documentRef.createElement('kbd');
      key.textContent = shortcut.keys;
      detail.appendChild(key);
      list.append(term, detail);
    }
    bodyElement.appendChild(list);
  }

  async function openConnect() {
    const currentView = open('Connect to Tau', 'connect');
    const frame = documentRef.createElement('iframe');
    frame.className = 'connection-qr';
    frame.src = '/api/qr';
    frame.title = 'Tau connection QR codes';
    bodyElement.appendChild(frame);
    setStatus('Loading connection details...');
    try {
      const response = await fetchImpl('/api/health');
      const health = await readJsonResponse(response, 'Failed to load connection details');
      if (currentView !== viewId) return;
      const urls = [
        ['Current', locationRef.origin],
        ['Local', health.mirrorUrl],
        ['Tailscale', health.tailscaleUrl],
      ].filter(([, url]) => Boolean(url));
      const list = documentRef.createElement('div');
      list.className = 'connection-urls';
      for (const [label, url] of urls) {
        const row = documentRef.createElement('div');
        row.className = 'connection-url-row';
        const main = documentRef.createElement('div');
        main.className = 'connection-url-main';
        const name = documentRef.createElement('span');
        name.textContent = label;
        const link = documentRef.createElement('a');
        link.href = url;
        link.textContent = url;
        main.append(name, link);
        const copy = documentRef.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy';
        copy.setAttribute('aria-label', `Copy ${url}`);
        copy.addEventListener('click', async () => {
          try {
            await copyText(url, { clipboard, documentRef });
            setStatus('Copied');
          } catch (error) {
            setStatus(error.message, true);
          }
        });
        row.append(main, copy);
        list.appendChild(row);
      }
      bodyElement.prepend(list);
      setStatus('');
    } catch (error) {
      if (currentView === viewId) setStatus(error.message, true);
    }
  }

  return {
    close,
    openConnect,
    openExport,
    openHotkeys,
    openInfo,
    openPanel,
    openRename,
    rename: (session, name) => renameSession({ ...session, name, request, mutationFetch })
      .then(async (result) => {
        await onRenamed({ ...session, name });
        return result;
      }),
  };
}
